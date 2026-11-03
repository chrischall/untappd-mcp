// Favorite beers, breweries and venues — cache only, never an API call.
//
// Three sources, merged per (kind, id) so an item is listed ONCE with every
// source that names it:
//  - `derived`: computed on read from the cached history with the thresholds
//    below (each a parameter; the defaults are the owner's spec). Computed, not
//    stored, so it always reflects the latest sync — every result carries the
//    reason it qualified.
//  - `manual`: the local `favorites` table (untappd_favorite_add / _remove).
//    Never written to Untappd.
//  - `untappd`: the breweries the user "likes" on Untappd (user/brewerylikes,
//    mirrored by untappd_sync_brewery_likes into `brewery_likes`). Breweries
//    only: Untappd has no followed/favorite venue (or beer) list. brewery/info's
//    follow_status is the AUTHENTICATED account's and is never used here.
import type { BreweryLikeRow, CacheStore, FavoriteKind, VisitedVenue } from './store.js';

export type FavoriteSource = 'untappd' | 'derived' | 'manual';
export const FAVORITE_SOURCES = ['untappd', 'derived', 'manual'] as const;

export interface FavoriteThresholds {
  /** A venue with at least this many check-ins is a favorite. */
  venue_min_checkins: number;
  /** …or visits spanning at least this many distinct calendar months (first_visit → recent_visit). */
  venue_min_months: number;
  /** A brewery with at least this many beers had… */
  brewery_min_beers: number;
  /** …and at least this average rating (over the beers the user rated) is a favorite. */
  brewery_min_avg_rating: number;
  /** A brewery with at least this many beers had is a favorite regardless of rating. */
  brewery_min_beers_any_rating: number;
  /** A beer the user rated at least this is a favorite. */
  beer_min_rating: number;
  /** …or had at least this many times. */
  beer_min_times_had: number;
}

export const DEFAULT_FAVORITE_THRESHOLDS: Readonly<FavoriteThresholds> = Object.freeze({
  venue_min_checkins: 5,
  venue_min_months: 3,
  brewery_min_beers: 5,
  brewery_min_avg_rating: 3.75,
  brewery_min_beers_any_rating: 15,
  beer_min_rating: 4.25,
  beer_min_times_had: 3,
});

/** Rating a brewery with no rated beers is ranked at (a neutral mid-scale value). */
const UNRATED_BREWERY_RATING = 3.5;

/** The `favorite` field attached to results across the server. */
export interface FavoriteInfo {
  is_favorite: boolean;
  /** Every source naming it, in {@link FAVORITE_SOURCES} order, no duplicates. */
  sources: FavoriteSource[];
  /** Why — derived reason and/or the manual note; null when not a favorite. */
  reason: string | null;
}

export const NOT_FAVORITE: Readonly<FavoriteInfo> = Object.freeze({ is_favorite: false, sources: [], reason: null });

export interface DerivedFavorite {
  kind: FavoriteKind;
  id: number;
  name: string | null;
  reason: string;
  /** Rank key (higher first): total_count for venues, blended count×rating for breweries, rating for beers. */
  score: number;
  metrics: Record<string, unknown>;
}

export interface FavoriteEntry extends FavoriteInfo {
  kind: FavoriteKind;
  id: number;
  name: string | null;
  /** Untappd-liked breweries only: when the user liked it. */
  liked_at?: string | null;
  /** Manual favorites only. */
  note?: string | null;
  created_at?: string;
  /** Derived favorites only. */
  score?: number;
  metrics?: Record<string, unknown>;
}

function thresholds(t?: Partial<FavoriteThresholds>): FavoriteThresholds {
  const out = { ...DEFAULT_FAVORITE_THRESHOLDS };
  for (const [k, v] of Object.entries(t ?? {})) if (v !== undefined) (out as Record<string, number>)[k] = v as number;
  return out;
}

/** Calendar months covered from `first` to `recent`, inclusive (UTC); 0 when either is missing. */
export function monthSpan(first: string | null, recent: string | null): number {
  if (!first || !recent) return 0;
  const a = new Date(first);
  const b = new Date(recent);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
  return Math.max(months, 1);
}

const fmt = (x: number) => String(Number(x.toFixed(2)));
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : '?');

function deriveVenue(v: VisitedVenue, t: FavoriteThresholds): DerivedFavorite | null {
  const count = v.total_count ?? 0;
  const months = monthSpan(v.first_visit, v.recent_visit);
  const byCount = count >= t.venue_min_checkins;
  // Only first/recent visit dates are known, so N visits can cover at most N
  // distinct months: a 2-visit venue is never a "3 distinct months" favorite.
  const byMonths = months >= t.venue_min_months && count >= t.venue_min_months;
  if (!byCount && !byMonths) return null;
  const reason = byCount
    ? `${count} check-ins since ${v.first_visit ? v.first_visit.slice(0, 4) : 'unknown'}`
    : `${count} check-ins over ${months} months (${ym(v.first_visit)} to ${ym(v.recent_visit)})`;
  return {
    kind: 'venue',
    id: v.venue_id,
    name: v.name,
    reason,
    score: count,
    metrics: { total_count: count, months_spanned: months, first_visit: v.first_visit, recent_visit: v.recent_visit, city: v.city, state: v.state },
  };
}

/**
 * Derived favorites of one kind for one user, best first. `ids` restricts the
 * check to those items (for annotating results); thresholds default to the spec.
 */
export async function deriveFavorites(
  cache: CacheStore,
  username: string,
  kind: FavoriteKind,
  t?: Partial<FavoriteThresholds>,
  ids?: number[],
): Promise<DerivedFavorite[]> {
  const th = thresholds(t);
  const out: DerivedFavorite[] = [];
  if (kind === 'venue') {
    const rows = await cache.venueVisitStats(username, {
      venueIds: ids,
      minCheckins: Math.min(th.venue_min_checkins, th.venue_min_months),
    });
    for (const v of rows) {
      const f = deriveVenue(v, th);
      if (f) out.push(f);
    }
  } else if (kind === 'brewery') {
    for (const b of await cache.breweryHadStats(username, ids)) {
      const byRating = b.beers >= th.brewery_min_beers && b.avg_rating !== null && b.avg_rating >= th.brewery_min_avg_rating;
      const byCount = b.beers >= th.brewery_min_beers_any_rating;
      if (!byRating && !byCount) continue;
      const avg = b.avg_rating;
      const reason = byRating
        ? `avg ${fmt(avg!)} across ${b.rated_beers === b.beers ? `${b.beers} beers` : `${b.rated_beers} rated of ${b.beers} beers`}`
        : `${b.beers} beers had${avg !== null ? ` (avg ${fmt(avg)})` : ''}`;
      out.push({
        kind: 'brewery',
        id: b.brewery_id,
        name: b.brewery_name,
        reason,
        // Blend: average rating weighted by log2(beers + 1) — more beers matters, with diminishing returns.
        score: Number(((avg ?? UNRATED_BREWERY_RATING) * Math.log2(b.beers + 1)).toFixed(3)),
        metrics: { beers: b.beers, rated_beers: b.rated_beers, avg_rating: avg === null ? null : Number(avg.toFixed(3)) },
      });
    }
  } else {
    const rows = await cache.beerHadStats(username, ids ? { bids: ids } : { minRating: th.beer_min_rating, minTimesHad: th.beer_min_times_had });
    for (const b of rows) {
      const byRating = b.rating !== null && b.rating >= th.beer_min_rating;
      const byTimes = b.times_had >= th.beer_min_times_had;
      if (!byRating && !byTimes) continue;
      const parts: string[] = [];
      if (byRating) parts.push(`rated ${fmt(b.rating!)}`);
      if (byTimes) parts.push(`had ${b.times_had} times`);
      out.push({
        kind: 'beer',
        id: b.bid,
        name: b.beer_name,
        reason: parts.join(', '),
        score: b.rating ?? 0,
        metrics: { rating: b.rating, times_had: b.times_had, brewery_id: b.brewery_id, brewery_name: b.brewery_name },
      });
    }
    out.sort((a, b) => b.score - a.score || Number(b.metrics.times_had) - Number(a.metrics.times_had) || a.id - b.id);
    return out;
  }
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  return out;
}

const manualReason = (note: string | null) => (note ? `manual: ${note}` : 'added manually');
const likedReason = (l: BreweryLikeRow) => (l.liked_at ? `liked on Untappd (since ${ym(l.liked_at)})` : 'liked on Untappd');

/** The user's Untappd brewery likes (the only kind Untappd has a list for). */
async function likesFor(cache: CacheStore, username: string, kind: FavoriteKind, ids?: number[]): Promise<BreweryLikeRow[]> {
  if (kind !== 'brewery') return [];
  return cache.getBreweryLikes(username, ids);
}

function orderSources(s: Iterable<FavoriteSource>): FavoriteSource[] {
  const set = new Set(s);
  return FAVORITE_SOURCES.filter((x) => set.has(x));
}

/**
 * Every favorite of one user (optionally one kind / one source), each listed
 * once with merged sources: derived ones in rank order, then manual-only ones
 * newest first, then Untappd-liked-only ones, most recently liked first.
 */
export async function listFavorites(
  cache: CacheStore,
  username: string,
  opts: { kind?: FavoriteKind; source?: FavoriteSource; thresholds?: Partial<FavoriteThresholds> } = {},
): Promise<FavoriteEntry[]> {
  const kinds: FavoriteKind[] = opts.kind ? [opts.kind] : ['venue', 'brewery', 'beer'];
  const out: FavoriteEntry[] = [];
  for (const kind of kinds) {
    const manual = await cache.getManualFavorites(username, { kind });
    const manualById = new Map(manual.map((m) => [m.id, m]));
    const liked = await likesFor(cache, username, kind);
    const likedById = new Map(liked.map((l) => [l.brewery_id, l]));
    // Filtering to a source this kind has nothing in: no need to derive (it only adds merged sources).
    const skipDerived = (opts.source === 'manual' && manual.length === 0) || (opts.source === 'untappd' && liked.length === 0);
    const derived = skipDerived ? [] : await deriveFavorites(cache, username, kind, opts.thresholds);
    const derivedById = new Map(derived.map((d) => [d.id, d]));
    const entry = (id: number): FavoriteEntry => {
      const d = derivedById.get(id);
      const m = manualById.get(id);
      const l = likedById.get(id);
      const sources: FavoriteSource[] = [];
      const reasons: string[] = [];
      // Reasons follow FAVORITE_SOURCES order: untappd, derived, manual.
      if (l) {
        sources.push('untappd');
        reasons.push(likedReason(l));
      }
      if (d) {
        sources.push('derived');
        reasons.push(d.reason);
      }
      if (m) {
        sources.push('manual');
        reasons.push(manualReason(m.note));
      }
      return {
        kind,
        id,
        name: d?.name ?? m?.name ?? l?.brewery_name ?? null,
        is_favorite: true,
        sources: orderSources(sources),
        reason: reasons.join('; '),
        ...(l ? { liked_at: l.liked_at } : {}),
        ...(m ? { note: m.note, created_at: m.created_at } : {}),
        ...(d ? { score: d.score, metrics: d.metrics } : {}),
      };
    };
    const seen = new Set<number>();
    const ids = [...derived.map((d) => d.id), ...manual.map((m) => m.id), ...liked.map((l) => l.brewery_id)].filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    for (const id of ids) {
      const e = entry(id);
      if (opts.source && !e.sources.includes(opts.source)) continue;
      out.push(e);
    }
  }
  return out;
}

/** Answers "is this a favorite?" for the ids it was built for. */
export interface FavoriteIndex {
  get(kind: FavoriteKind, id: number | null | undefined): FavoriteInfo;
  isFavorite(kind: FavoriteKind, id: number | null | undefined): boolean;
}

/**
 * Build a {@link FavoriteIndex} for the given ids, for one user or a group (a
 * favorite of ANY member counts; with several users each reason part names its
 * user). Cache only. Shared by every tool that carries a `favorite` field.
 */
export async function favoriteLookup(
  cache: CacheStore,
  usernames: string[],
  ids: Partial<Record<FavoriteKind, Array<number | null | undefined>>>,
  t?: Partial<FavoriteThresholds>,
): Promise<FavoriteIndex> {
  const group = usernames.length > 1;
  const map = new Map<string, { sources: Set<FavoriteSource>; reasons: string[] }>();
  const add = (kind: FavoriteKind, id: number, source: FavoriteSource, reason: string, user: string) => {
    const k = `${kind}:${id}`;
    const cur = map.get(k) ?? { sources: new Set<FavoriteSource>(), reasons: [] };
    cur.sources.add(source);
    cur.reasons.push(group ? `${user}: ${reason}` : reason);
    map.set(k, cur);
  };
  for (const kind of ['beer', 'brewery', 'venue'] as const) {
    const list = [...new Set((ids[kind] ?? []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)))];
    if (list.length === 0) continue;
    for (const user of usernames) {
      const derived = await deriveFavorites(cache, user, kind, t, list);
      const manual = await cache.getManualFavorites(user, { kind, ids: list });
      const manualIds = new Map(manual.map((m) => [m.id, m]));
      const liked = new Map((await likesFor(cache, user, kind, list)).map((l) => [l.brewery_id, l]));
      // Per user, for each id: untappd, derived, then manual reason.
      for (const id of list) {
        const l = liked.get(id);
        if (l) add(kind, id, 'untappd', likedReason(l), user);
        const d = derived.find((x) => x.id === id);
        if (d) add(kind, id, 'derived', d.reason, user);
        const m = manualIds.get(id);
        if (m) add(kind, id, 'manual', manualReason(m.note), user);
      }
    }
  }
  const get = (kind: FavoriteKind, id: number | null | undefined): FavoriteInfo => {
    if (id === null || id === undefined) return { ...NOT_FAVORITE, sources: [] };
    const hit = map.get(`${kind}:${id}`);
    if (!hit) return { ...NOT_FAVORITE, sources: [] };
    return { is_favorite: true, sources: orderSources(hit.sources), reason: hit.reasons.join('; ') };
  };
  return { get, isFavorite: (kind, id) => get(kind, id).is_favorite };
}
