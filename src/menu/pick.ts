// The untappd_menu_pick / untappd_venue_pick pipeline: freshen the user's
// distinct-beers cache, resolve each menu line to a bid, check every bid
// against the cache, and rank what the user hasn't had.
//
// Everything runs under ONE per-call API budget (Untappd allows ~100
// calls/hour per token): the sync gets what resolution doesn't need, and
// anything the budget can't cover comes back flagged for another run rather
// than looping.

import { RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { beerMetaFrom, type BeerMeta, type CacheStore, type ItemResolution } from '../cache/store.js';
import { syncUserBeers } from '../cache/sync-beers.js';
import {
  breweryNameMatch,
  candidateFromSearch,
  isConfident,
  looksSeasonal,
  normalizeLine,
  rankCandidates,
  searchQueries,
  type Candidate,
  type NormalizedLine,
} from './match.js';
import { walkVenueMenu } from './venue-menu.js';

// Re-fetch cached beer metadata at most this often (matches untappd_top_not_had).
const BEER_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A brewery's "possible" list goes stale as it releases beers; a no-match line
// may start matching once someone adds the beer. Resolved bids don't change.
const POSSIBLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNRESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
// Bump when matching logic changes, so old resolutions are re-scored.
const RESOLUTION_KEY_VERSION = 'r1';
const SEARCH_LIMIT = 15;
const POSSIBLE_MAX = 8;
const DEFAULT_CONCURRENCY = 4;
// 429 handling: retry this many times, waiting at most this long. A longer
// Retry-After is the hourly limit itself — waiting it out inside a tool call
// is pointless, so the item is reported for another run instead.
const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 8000;

/** Per-call API budget. Every request the pipeline sends takes one unit. */
export class ApiBudget {
  used = 0;
  constructor(readonly limit: number) {}
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}

class BudgetExhausted extends Error {
  constructor() {
    super('API budget exhausted');
  }
}

export interface PickDeps {
  /** Injectable for tests (backoff waits). */
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Call `fn` under the budget, retrying a 429 with bounded backoff. */
async function guarded<T>(budget: ApiBudget, sleep: (ms: number) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!budget.take()) throw new BudgetExhausted();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof RateLimitError) || attempt >= MAX_RETRIES) throw e;
      const wait = e.retryAfterSeconds !== undefined ? e.retryAfterSeconds * 1000 : 1000 * 2 ** attempt;
      if (wait > MAX_BACKOFF_MS) throw e;
      await sleep(wait);
    }
  }
}

/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ── 1. freshness ──

export interface SyncReport {
  mode: 'incremental' | 'backfill';
  api_calls: number;
  coverage_complete: boolean;
  cached_distinct_beers: number;
  total_distinct_beers: number | null;
  another_run_needed: boolean;
  /** Incremental runs: where paging stopped (the first unchanged cached beer). */
  stopped_at_bid?: number | null;
  rate_limited?: true;
  skipped?: string;
  error?: string;
}

/**
 * Bring the user's distinct-beers cache up to date within `maxCalls`: an
 * incremental top-of-list refresh when the cache is complete (it stops at the
 * first unchanged cached beer), otherwise a backfill that resumes from the
 * persisted offset and pages until done or out of budget.
 */
export async function ensureFresh(
  client: UntappdClient,
  cache: CacheStore,
  username: string,
  maxCalls: number,
): Promise<SyncReport> {
  const prior = await cache.getState(username);
  const mode = prior?.beers_complete ? 'incremental' : 'backfill';
  let calls = 0;
  const counting = { get: (p: string, q?: Record<string, unknown>) => (calls++, client.get(p, q as never)) } as unknown as UntappdClient;
  const extra: Partial<SyncReport> = {};
  if (maxCalls < 1) {
    extra.skipped = 'no API budget left for a sync this run';
  } else {
    try {
      const s = await syncUserBeers(counting, cache, username, maxCalls);
      if (s.incremental) extra.stopped_at_bid = s.stopped_at_bid;
    } catch (e) {
      if (e instanceof RateLimitError) extra.rate_limited = true;
      else extra.error = messageOf(e);
    }
  }
  const state = await cache.getState(username);
  const complete = (state?.beers_complete ?? false) || (state?.backfill_complete ?? false);
  return {
    mode,
    api_calls: calls,
    coverage_complete: complete,
    cached_distinct_beers: await cache.distinctBeersCount(username),
    total_distinct_beers: state?.beers_total ?? null,
    another_run_needed: !complete,
    ...extra,
  };
}

// ── 2/3. resolution ──

/** A menu line resolved to one beer. */
export interface ResolvedBeer {
  item: string;
  bid: number;
  name: string;
  brewery: string;
  style: string | null;
  abv: number | null;
  /** Global rating, when the resolving source carried one. */
  rating?: number | null;
}

export interface PossibleCandidate {
  bid: number;
  name: string;
  style: string | null;
  abv: number | null;
  global_rating: number | null;
  had?: boolean;
}

export interface PossibleLine {
  item: string;
  brewery?: string;
  reason: string;
  candidates: PossibleCandidate[];
  needs_confirmation: true;
}

export interface UnresolvedLine {
  item: string;
  reason: string;
}

type LineOutcome =
  | { kind: 'resolved'; beer: ResolvedBeer; cached: boolean }
  | { kind: 'possible'; possible: PossibleLine; cached: boolean }
  | { kind: 'unresolved'; unresolved: UnresolvedLine; cacheable: boolean; cached: boolean };

function resolutionKey(line: NormalizedLine, venueCity: string | undefined): string {
  const city = venueCity ? venueCity.trim().toLowerCase() : '';
  const text = line.kind === 'brewery_generic' ? `brewery:${line.breweryHint}` : line.tokens.join(' ');
  return `${RESOLUTION_KEY_VERSION}|${text}|${city}`;
}

function fromCache(row: ItemResolution, item: string, nowMs: number): LineOutcome | null {
  const age = nowMs - Date.parse(row.resolved_at);
  try {
    const data = row.data ? JSON.parse(row.data) : null;
    if (row.status === 'resolved' && row.bid !== null && data) {
      return { kind: 'resolved', beer: { ...data, item }, cached: true };
    }
    if (row.status === 'possible' && data && age < POSSIBLE_TTL_MS) {
      return { kind: 'possible', possible: { ...data, item }, cached: true };
    }
    if (row.status === 'unresolved' && data && age < UNRESOLVED_TTL_MS) {
      return { kind: 'unresolved', unresolved: { item, reason: data.reason }, cacheable: false, cached: true };
    }
  } catch {
    /* corrupt row — re-resolve */
  }
  return null;
}

function toResolution(key: string, item: string, o: LineOutcome, nowIso: string): ItemResolution | null {
  if (o.cached) return null;
  if (o.kind === 'resolved') {
    const { item: _i, ...beer } = o.beer;
    return { key, item, status: 'resolved', bid: o.beer.bid, data: JSON.stringify(beer), resolved_at: nowIso };
  }
  if (o.kind === 'possible') {
    const { item: _i, ...p } = o.possible;
    return { key, item, status: 'possible', bid: null, data: JSON.stringify(p), resolved_at: nowIso };
  }
  if (!o.cacheable) return null;
  return { key, item, status: 'unresolved', bid: null, data: JSON.stringify({ reason: o.unresolved.reason }), resolved_at: nowIso };
}

interface ResolveCtx {
  client: UntappdClient;
  cache: CacheStore;
  budget: ApiBudget;
  sleep: (ms: number) => Promise<void>;
  venueCity?: string;
  nowIso: string;
}

/** Turn an API failure during resolution into an unresolved line (never cached). */
function failure(item: string, e: unknown): LineOutcome {
  const reason =
    e instanceof BudgetExhausted
      ? 'api budget exhausted — run again to resolve'
      : e instanceof RateLimitError
        ? 'rate limited by Untappd — run again later'
        : `lookup failed: ${messageOf(e)}`;
  return { kind: 'unresolved', unresolved: { item, reason }, cacheable: false, cached: false };
}

async function resolveBeerLine(line: NormalizedLine, ctx: ResolveCtx): Promise<LineOutcome> {
  const cands: Candidate[] = [];
  let ranked = rankCandidates(line.tokens, cands, ctx.venueCity);
  // Most specific query first; the style-less fallback only when the first
  // found nothing confident (Untappd ANDs every term, so "… nashville blonde"
  // can return zero hits while "… nashville" finds the beer).
  for (const q of searchQueries(line)) {
    const data = await guarded(ctx.budget, ctx.sleep, () =>
      ctx.client.get<{ beers?: { items?: unknown[] } }>('/search/beer', { q, limit: SEARCH_LIMIT }),
    );
    for (const it of data?.beers?.items ?? []) {
      const c = candidateFromSearch(it);
      if (c) cands.push(c);
    }
    ranked = rankCandidates(line.tokens, cands, ctx.venueCity);
    if (isConfident(ranked[0])) break;
  }
  const top = ranked[0];
  if (isConfident(top)) {
    return {
      kind: 'resolved',
      beer: { item: line.raw, bid: top.bid, name: top.name, brewery: top.brewery, style: top.style, abv: top.abv },
      cached: false,
    };
  }
  if (ranked.length) {
    return {
      kind: 'possible',
      possible: {
        item: line.raw,
        reason: 'no confident match — pick one',
        candidates: ranked.slice(0, 3).map((c) => ({
          bid: c.bid, name: `${c.brewery} ${c.name}`.trim(), style: c.style, abv: c.abv, global_rating: c.rating,
        })),
        needs_confirmation: true,
      },
      cached: false,
    };
  }
  return { kind: 'unresolved', unresolved: { item: line.raw, reason: 'no Untappd match' }, cacheable: true, cached: false };
}

interface BreweryListItem {
  total_count?: number;
  beer?: Record<string, unknown>;
  brewery?: unknown;
}

/**
 * "<Brewery> SEASONAL": find the brewery, then offer its in-production beers
 * that look seasonal/limited (falling back to its newest releases) as
 * `possible` candidates — the menu doesn't say which one is pouring.
 * Brewery lists carry global ratings, so they also seed beer metadata.
 */
async function resolveBreweryLine(line: NormalizedLine, ctx: ResolveCtx): Promise<LineOutcome> {
  const hint = line.breweryHint ?? '';
  const found = await guarded(ctx.budget, ctx.sleep, () =>
    ctx.client.get<{ brewery?: { items?: Array<{ brewery?: Record<string, unknown> }> } }>('/search/brewery', { q: hint, limit: 10 }),
  );
  const breweries = (found?.brewery?.items ?? [])
    .map((i) => i.brewery ?? {})
    .map((b) => {
      const city = (b.location as { brewery_city?: unknown } | undefined)?.brewery_city;
      const sameCity = ctx.venueCity && typeof city === 'string' && city.toLowerCase() === ctx.venueCity.toLowerCase();
      return { b, score: breweryNameMatch(hint, String(b.brewery_name ?? '')) + (sameCity ? 0.25 : 0) };
    })
    .filter((x) => typeof x.b.brewery_id === 'number' && x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const brewery = breweries[0]?.b;
  if (!brewery) {
    return { kind: 'unresolved', unresolved: { item: line.raw, reason: `brewery "${hint}" not found` }, cacheable: true, cached: false };
  }
  const list = await guarded(ctx.budget, ctx.sleep, () =>
    ctx.client.get<{ beers?: { items?: BreweryListItem[] } }>(`/brewery/beer_list/${brewery.brewery_id}`, { limit: 50 }),
  );
  const items = (list?.beers?.items ?? []).filter((i) => typeof i.beer?.bid === 'number');
  const meta = items.map((i) => beerMetaFrom(i.beer, i.brewery ?? brewery, ctx.nowIso)).filter((m): m is BeerMeta => m !== null);
  if (meta.length) await ctx.cache.upsertBeerMeta(meta);

  const live = items.filter((i) => i.beer?.is_in_production !== 0);
  const seasonal = live.filter((i) => looksSeasonal(String(i.beer?.beer_name ?? ''), (i.beer?.beer_style as string) ?? null));
  // No seasonal-looking names: the newest releases are the next-best guess at
  // "what's rotating"; the list itself is popularity-ordered.
  const newest = live
    .slice()
    .sort((a, b) => Date.parse(String(b.beer?.created_at ?? '')) - Date.parse(String(a.beer?.created_at ?? '')) || 0);
  const chosen = (seasonal.length ? seasonal : newest).slice(0, POSSIBLE_MAX);
  if (!chosen.length) {
    return { kind: 'unresolved', unresolved: { item: line.raw, reason: 'brewery has no beers listed' }, cacheable: true, cached: false };
  }
  return {
    kind: 'possible',
    possible: {
      item: line.raw,
      brewery: String(brewery.brewery_name ?? hint),
      reason: seasonal.length ? 'seasonal-looking beers from this brewery' : "brewery's newest releases",
      candidates: chosen.map((i) => ({
        bid: i.beer!.bid as number,
        name: String(i.beer!.beer_name ?? ''),
        style: (i.beer!.beer_style as string) ?? null,
        abv: typeof i.beer!.beer_abv === 'number' ? i.beer!.beer_abv : null,
        global_rating: typeof i.beer!.rating_score === 'number' && i.beer!.rating_score > 0 ? i.beer!.rating_score : null,
      })),
      needs_confirmation: true,
    },
    cached: false,
  };
}

// ── 4/5. check + rank ──

export interface NotHadBeer {
  item: string;
  bid: number;
  name: string;
  brewery: string;
  style: string | null;
  abv: number | null;
  global_rating: number | null;
  stale_rating?: true;
}

export interface HadBeer {
  item: string;
  bid: number;
  name: string;
  brewery: string;
  count: number;
  last_date: string | null;
  user_rating: number | null;
}

export interface PickResult {
  picks: Array<NotHadBeer & { reason: string }>;
  not_had: NotHadBeer[];
  had: HadBeer[];
  possible: PossibleLine[];
  unresolved: UnresolvedLine[];
}

const ratingOf = (m: BeerMeta | undefined): number | null => m?.weighted_rating_score ?? m?.rating_score ?? null;

/**
 * Split resolved beers into had / not-had from the cache (no API), fill in
 * global ratings for the not-had ones (beer_meta, else beer/info within the
 * budget), and rank. `possible` candidates get a `had` flag but are never
 * picks — the caller has to confirm which one is actually pouring.
 */
async function checkAndRank(
  ctx: ResolveCtx & { concurrency: number },
  username: string,
  resolved: ResolvedBeer[],
  possible: PossibleLine[],
  styleFilter: string | undefined,
  topN: number,
): Promise<Omit<PickResult, 'unresolved'> & { rating_fetch_deferred: number }> {
  const { cache } = ctx;
  const seen = new Set<number>();
  const had: HadBeer[] = [];
  const notHadBeers: ResolvedBeer[] = [];
  for (const r of resolved) {
    if (seen.has(r.bid)) continue;
    seen.add(r.bid);
    const h = await cache.hasHad(username, { bid: r.bid });
    if (h.had) {
      had.push({ item: r.item, bid: r.bid, name: r.name, brewery: r.brewery, count: h.count, last_date: h.last_date, user_rating: h.best_rating });
    } else notHadBeers.push(r);
  }
  for (const p of possible) {
    for (const c of p.candidates) c.had = (await cache.hasHad(username, { bid: c.bid })).had;
  }

  // Ratings: a fresh cached rating is used as-is; otherwise beer/info, within
  // the budget. A null cached rating counts as missing — search results carry
  // no rating, so a null there means "never fetched", not "unrated".
  const nowMs = Date.parse(ctx.nowIso);
  const metaByBid = new Map((await cache.getBeerMeta(notHadBeers.map((b) => b.bid))).map((m) => [m.bid, m]));
  const fresh = (m: BeerMeta | undefined) =>
    !!m && ratingOf(m) !== null && !!m.fetched_at && nowMs - Date.parse(m.fetched_at) < BEER_META_TTL_MS;
  const need = notHadBeers.filter((b) => !fresh(metaByBid.get(b.bid)) && b.rating == null);
  let deferred = 0;
  const fetched = await mapPool(need, ctx.concurrency, async (b) => {
    try {
      const data = await guarded(ctx.budget, ctx.sleep, () =>
        ctx.client.get<{ beer?: unknown }>(`/beer/info/${b.bid}`, { compact: 'true' }),
      );
      return beerMetaFrom(data?.beer, undefined, ctx.nowIso);
    } catch {
      deferred++;
      return null;
    }
  });
  const newMeta = fetched.filter((m): m is BeerMeta => m !== null);
  if (newMeta.length) await cache.upsertBeerMeta(newMeta);
  for (const m of newMeta) metaByBid.set(m.bid, m);

  const not_had: NotHadBeer[] = notHadBeers.map((b) => {
    const m = metaByBid.get(b.bid);
    const rating = b.rating ?? ratingOf(m);
    return {
      item: b.item,
      bid: b.bid,
      name: b.name,
      brewery: b.brewery,
      style: b.style ?? m?.style ?? null,
      abv: b.abv ?? m?.abv ?? null,
      global_rating: rating !== null ? Math.round(rating * 100) / 100 : null,
      ...(m && rating !== null && b.rating == null && !fresh(m) ? { stale_rating: true as const } : {}),
    };
  });
  not_had.sort((a, b) => (b.global_rating ?? -1) - (a.global_rating ?? -1));

  const s = styleFilter?.toLowerCase();
  const eligible = s
    ? not_had.filter((b) => {
        const parent = metaByBid.get(b.bid)?.parent_style ?? '';
        return (b.style ?? '').toLowerCase().includes(s) || parent.toLowerCase().includes(s);
      })
    : not_had;
  const picks = eligible.slice(0, topN).map((b, i) => ({
    ...b,
    reason:
      `not had · ` +
      (b.global_rating !== null ? `${b.global_rating.toFixed(2)} global rating` : 'no global rating yet') +
      ` · #${i + 1} of ${eligible.length} not-had${s ? ` "${styleFilter}"` : ''} beer${eligible.length === 1 ? '' : 's'} on this list`,
  }));
  return { picks, not_had, had, possible, rating_fetch_deferred: deferred };
}

// ── orchestration ──

export interface MenuPickInput {
  username: string;
  items: string[];
  styleFilter?: string;
  topN: number;
  apiBudget: number;
  venueCity?: string;
  /** Ignore cached line→bid resolutions and re-search every line. */
  refreshResolutions?: boolean;
}

export interface PickOutput extends PickResult {
  sync: SyncReport;
  api_calls: number;
  api_budget: number;
  another_run_needed: boolean;
}

/** untappd_menu_pick: raw menu lines in, ranked not-had picks out. */
export async function menuPick(
  client: UntappdClient,
  cache: CacheStore,
  input: MenuPickInput,
  deps: PickDeps = {},
): Promise<PickOutput> {
  const budget = new ApiBudget(input.apiBudget);
  const sleep = deps.sleep ?? defaultSleep;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const ctx = { client, cache, budget, sleep, venueCity: input.venueCity, nowIso, concurrency };

  // Resolution cache first (no API) so the sync budget can leave room for misses.
  const lines = input.items.map(normalizeLine);
  const keys = lines.map((l) => resolutionKey(l, input.venueCity));
  const cachedRows = input.refreshResolutions ? [] : await cache.getResolutions(keys.filter((_, i) => lines[i].kind !== 'generic'));
  const byKey = new Map(cachedRows.map((r) => [r.key, r]));
  const outcomes: Array<LineOutcome | undefined> = lines.map((l, i) => {
    if (l.kind === 'generic') {
      return { kind: 'unresolved', unresolved: { item: l.raw, reason: 'ask bartender' }, cacheable: false, cached: false };
    }
    const row = byKey.get(keys[i]);
    return row ? (fromCache(row, l.raw, nowMs) ?? undefined) : undefined;
  });
  const misses = outcomes.filter((o) => o === undefined).length;

  // Reserve ~2 calls per unresolved line (search + fallback, or brewery search +
  // beer list) and ~1 per beer for a rating lookup; the sync gets the rest, but
  // never less than one page (the incremental refresh's cost).
  const reserve = misses * 3;
  const syncCalls = Math.min(budget.remaining, Math.max(1, budget.remaining - reserve));
  const sync = await ensureFresh(client, cache, input.username, syncCalls);
  budget.used += sync.api_calls;

  const misIdx = outcomes.map((o, i) => (o === undefined ? i : -1)).filter((i) => i >= 0);
  const resolvedNow = await mapPool(misIdx, concurrency, async (i) => {
    const line = lines[i];
    try {
      return line.kind === 'brewery_generic' ? await resolveBreweryLine(line, ctx) : await resolveBeerLine(line, ctx);
    } catch (e) {
      return failure(line.raw, e);
    }
  });
  misIdx.forEach((i, j) => (outcomes[i] = resolvedNow[j]));
  const toStore = misIdx
    .map((i) => toResolution(keys[i], lines[i].raw, outcomes[i]!, nowIso))
    .filter((r): r is ItemResolution => r !== null);
  if (toStore.length) await cache.upsertResolutions(toStore);

  const resolved: ResolvedBeer[] = [];
  const possible: PossibleLine[] = [];
  const unresolved: UnresolvedLine[] = [];
  for (const o of outcomes as LineOutcome[]) {
    if (o.kind === 'resolved') resolved.push(o.beer);
    else if (o.kind === 'possible') possible.push(o.possible);
    else unresolved.push(o.unresolved);
  }
  const ranked = await checkAndRank(ctx, input.username, resolved, possible, input.styleFilter, input.topN);
  const { rating_fetch_deferred, ...rest } = ranked;
  const retryable = unresolved.some((u) => /run again/.test(u.reason)) || rating_fetch_deferred > 0;
  return {
    ...rest,
    unresolved,
    sync,
    api_calls: budget.used,
    api_budget: budget.limit,
    another_run_needed: sync.another_run_needed || retryable,
  };
}

export interface VenuePickInput {
  username: string;
  venueId: number;
  styleFilter?: string;
  topN: number;
  apiBudget: number;
}

export interface VenuePickOutput extends PickOutput {
  venue: { venue_id: number; name: string | null; city: string | null; menu_beers: number; menu_total: number; menu_complete: boolean; menu_pages: number };
}

// Menu pages walk to completion within this many calls (menus are a handful of
// sections; 50 per page).
const VENUE_MENU_MAX_PAGES = 10;

/**
 * untappd_venue_pick: pull a venue's FULL verified menu (walking sections to
 * completion, within the budget), then run the same check + rank. Menu items
 * already carry bids, so there is no search step.
 */
export async function venuePick(
  client: UntappdClient,
  cache: CacheStore,
  input: VenuePickInput,
  deps: PickDeps = {},
): Promise<VenuePickOutput> {
  const budget = new ApiBudget(input.apiBudget);
  const sleep = deps.sleep ?? defaultSleep;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const nowIso = new Date().toISOString();

  // Leave at least one call for the sync's incremental refresh.
  let menuCalls = 0;
  const counting = {
    get: (p: string, q?: Record<string, unknown>) => (menuCalls++, client.get(p, q as never)),
  } as unknown as UntappdClient;
  const walk = await walkVenueMenu(counting, input.venueId, {
    maxPages: Math.max(1, Math.min(VENUE_MENU_MAX_PAGES, budget.remaining - 1)),
  });
  budget.used += menuCalls;

  const metaRows = walk.beers
    .map((b) => beerMetaFrom(b.rawBeer, b.rawBrewery, nowIso))
    .filter((m): m is BeerMeta => m !== null && ratingOf(m) !== null);
  if (metaRows.length) await cache.upsertBeerMeta(metaRows);

  const resolved: ResolvedBeer[] = walk.beers.map((b) => ({
    item: [b.brewery, b.name].filter((x) => typeof x === 'string' && x).join(' ').trim(),
    bid: b.bid,
    name: typeof b.name === 'string' ? b.name.trim() : String(b.name ?? ''),
    brewery: typeof b.brewery === 'string' ? b.brewery.trim() : '',
    style: typeof b.style === 'string' ? b.style : null,
    abv: typeof b.abv === 'number' ? b.abv : null,
  }));
  const distinctBids = new Set(resolved.map((r) => r.bid)).size;
  const cachedMeta = await cache.getBeerMeta([...new Set(resolved.map((r) => r.bid))]);
  const reserve = distinctBids - cachedMeta.filter((m) => ratingOf(m) !== null).length;
  const syncCalls = Math.min(budget.remaining, Math.max(1, budget.remaining - reserve));
  const sync = await ensureFresh(client, cache, input.username, syncCalls);
  budget.used += sync.api_calls;

  const ctx = { client, cache, budget, sleep, venueCity: walk.venueCity ?? undefined, nowIso, concurrency };
  const ranked = await checkAndRank(ctx, input.username, resolved, [], input.styleFilter, input.topN);
  const { rating_fetch_deferred, ...rest } = ranked;
  const unresolved: UnresolvedLine[] = walk.sawMenu
    ? []
    : [{ item: `venue ${input.venueId}`, reason: 'venue has no verified menu on Untappd — use untappd_menu_pick with the tap list' }];
  return {
    ...rest,
    unresolved,
    venue: {
      venue_id: input.venueId,
      name: walk.venueName,
      city: walk.venueCity,
      menu_beers: walk.beers.length,
      menu_total: walk.totalCount,
      menu_complete: walk.reachedEnd,
      menu_pages: walk.pagesFetched,
    },
    sync,
    api_calls: budget.used,
    api_budget: budget.limit,
    another_run_needed: sync.another_run_needed || rating_fetch_deferred > 0 || !walk.reachedEnd,
  };
}
