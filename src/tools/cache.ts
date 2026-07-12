import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, createHelpfulError, RateLimitError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { beerMetaFrom, type BeerMeta, type CacheStore, type SyncState } from '../cache/store.js';
import { syncCheckins } from '../cache/sync.js';
import { syncUserBeers } from '../cache/sync-beers.js';

// Re-fetch cached beer metadata at most this often; a hit newer than this skips
// the beer/info API call.
const BEER_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A source of the {@link CacheStore} to use for a request. Injected per
 * entrypoint so this module stays platform-neutral: the stdio server passes a
 * `node:sqlite` file cache; the Cloudflare connector passes a Durable Object
 * cache scoped to the authenticated operator.
 */
export type CacheProvider = () => CacheStore;

const UsernameArg = z
  .string()
  .min(1)
  .optional()
  .describe('Untappd username. Omit to use your own configured account (UNTAPPD_USERNAME).');

/** Resolve the target username (raw, un-encoded) — explicit arg else configured login. */
function resolveUser(username: string | undefined, loginName: string | null): string {
  const u = username ?? loginName;
  if (!u) {
    throw createHelpfulError('No username given and no configured account to fall back to.', {
      hint: 'Pass `username`, or set UNTAPPD_USERNAME so cache tools default to your own account.',
    });
  }
  return u;
}

function pct(cached: number, total: number | null, complete: boolean): number | null {
  if (total && total > 0) return Math.min(100, Math.round((cached / total) * 100));
  return complete ? 100 : null;
}

/**
 * Freshness block attached to every cache READ result. Reports each source's
 * completeness SEPARATELY — the user/checkins backfill (detailed, but truncated
 * by the API for non-self accounts) and the user/beers distinct-beers sync
 * (complete has-had coverage) — so a caller knows exactly which caveats apply.
 */
async function freshness(cache: CacheStore, username: string): Promise<Record<string, unknown>> {
  const state: SyncState | undefined = await cache.getState(username);
  const cachedCheckins = await cache.cachedCount(username);
  const cachedBeers = await cache.distinctBeersCount(username);
  const checkinsComplete = state?.backfill_complete ?? false;
  const checkinsTruncated = state?.checkins_truncated ?? false;
  const beersComplete = state?.beers_complete ?? false;
  const checkinsPercent = pct(cachedCheckins, state?.total_checkins ?? null, checkinsComplete);
  const beersPercent = pct(cachedBeers, state?.beers_total ?? null, beersComplete);
  // has-had coverage is complete if EITHER source fully covers the user's beers.
  const coverageComplete = beersComplete || checkinsComplete;
  const neverSynced = !state || state.last_synced_at === null;

  let caveat: string | undefined;
  if (neverSynced) {
    caveat =
      'This user has never been synced — the cache is EMPTY. Run untappd_sync_user_beers (cheapest, complete has-had coverage) or untappd_sync_checkins first; results here are not authoritative.';
  } else if (!coverageComplete) {
    const parts: string[] = [];
    parts.push(`distinct-beers ${beersPercent !== null ? `~${beersPercent}%` : 'not started'}`);
    if (checkinsTruncated) parts.push('check-in history is truncated by the API for this account');
    else parts.push(`check-in backfill ${checkinsPercent !== null ? `~${checkinsPercent}%` : 'incomplete'}`);
    caveat = `Coverage incomplete (${parts.join('; ')}). A "not found" may be a false negative — run untappd_sync_user_beers for full has-had coverage.`;
  }

  return {
    last_synced_at: state?.last_synced_at ?? null,
    coverage_complete: coverageComplete,
    checkins: {
      backfill_complete: checkinsComplete,
      history_truncated: checkinsTruncated,
      cached_checkins: cachedCheckins,
      total_checkins: state?.total_checkins ?? null,
      percent: checkinsPercent,
    },
    beers: {
      complete: beersComplete,
      cached_distinct_beers: cachedBeers,
      total_distinct_beers: state?.beers_total ?? null,
      percent: beersPercent,
    },
    ...(caveat ? { caveat } : {}),
  };
}

/**
 * Register the check-in cache tools. `cacheProvider` supplies the backing store
 * (a `node:sqlite` file on the stdio server, a Durable Object on the remote
 * connector) and is required so this module imports no platform-specific code.
 */
export function registerCacheTools(server: McpServer, client: UntappdClient, cacheProvider: CacheProvider): void {
  server.registerTool(
    'untappd_sync_checkins',
    {
      title: 'Sync a user\'s check-ins into the cache',
      description:
        "Fetch a user's detailed check-ins (venue, date, comment) into the cache from user/checkins. Incremental and " +
        'resumable: pages backwards up to max_pages per call, persisting progress every page; run again until ' +
        'another_run_needed is false. NOTE: Untappd only returns the ~50 most recent check-ins for accounts other ' +
        'than your own and will not page further — such a sync reports history_truncated and you should use ' +
        'untappd_sync_user_beers for full has-had coverage. backfill_complete is only reported once ~all of ' +
        'total_checkins is cached. Pass force_backfill: true to reset a cache wrongly marked complete and re-page ' +
        'the whole history (cached rows are kept). Omit username for your own account.',
      annotations: toolAnnotations({ title: "Sync a user's check-ins into the cache", readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Pages (50 check-ins each) to fetch this run (default 10). Keep modest to respect the ~100 calls/hour rate limit.'),
        force_backfill: z
          .boolean()
          .optional()
          .describe('Reset the sync state (clear backfill_complete + cursors) but KEEP cached rows, then re-page the whole history from newest. Use to recover a cache wrongly marked complete.'),
      },
    },
    async ({ username, max_pages, force_backfill }) => {
      const user = resolveUser(username, client.loginName);
      const summary = await syncCheckins(client, cacheProvider(), user, {
        maxPages: max_pages ?? 10,
        force: force_backfill ?? false,
      });
      return textResult(summary);
    },
  );

  server.registerTool(
    'untappd_sync_user_beers',
    {
      title: "Sync a user's complete distinct-beers list into the cache",
      description:
        "Fetch a user's COMPLETE distinct-beers list (every unique beer they've ever had, with their rating, " +
        'times-had count, and first/last dates) into the cache from user/beers. This is the cheapest way to get full ' +
        '"has had" coverage — thousands of beers instead of tens of thousands of check-ins — and, unlike ' +
        'user/checkins, it pages fully for any public/friend account. Offset-paged and resumable: fetches max_pages ' +
        'per call and persists progress; run again until another_run_needed is false. Feeds the same ' +
        'untappd_cache_has_had / has_had_many / not_had tools. Omit username for your own account.',
      annotations: toolAnnotations({ title: "Sync a user's complete distinct-beers list into the cache", readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Pages (50 beers each) to fetch this run (default 10). Keep modest to respect the ~100 calls/hour rate limit.'),
      },
    },
    async ({ username, max_pages }) => {
      const user = resolveUser(username, client.loginName);
      const summary = await syncUserBeers(client, cacheProvider(), user, max_pages ?? 10);
      return textResult(summary);
    },
  );

  server.registerTool(
    'untappd_cache_has_had',
    {
      title: 'Check if a user has had a beer (from the cache)',
      description:
        'Answer "has this user ever checked in this beer?" from the cache only — NO API call. Consults BOTH cached ' +
        'sources (check-ins and the distinct-beers list); a hit in either counts as had. Match by exact bid or a ' +
        'case-insensitive substring of the beer name. Returns whether they had it, the times-had count, best rating, ' +
        'last date, which sources matched, and any detailed check-ins. Reports per-source freshness so you can ' +
        'caveat incomplete data. Requires bid or beer_name. Run untappd_sync_user_beers first for full coverage.',
      annotations: toolAnnotations({ title: 'Check if a user has had a beer (from the cache)', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: {
        username: UsernameArg,
        bid: z.number().int().positive().optional().describe('Exact Untappd beer id to look for'),
        beer_name: z.string().min(1).optional().describe('Case-insensitive substring match on the beer name'),
      },
    },
    async ({ username, bid, beer_name }) => {
      if (bid === undefined && beer_name === undefined) {
        throw createHelpfulError('Provide either bid or beer_name.', { hint: 'bid is exact; beer_name is a case-insensitive substring match.' });
      }
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const result = await cache.hasHad(user, { bid, beerName: beer_name });
      return textResult({ username: user, query: { bid, beer_name }, ...result, freshness: await freshness(cache, user) });
    },
  );

  server.registerTool(
    'untappd_cache_has_had_many',
    {
      title: 'Batch-check many beers against the cache',
      description:
        'Cross-check a list of beer ids against a user\'s cached history in ONE call — NO API call. Consults BOTH ' +
        'sources (check-ins + distinct beers). Returns had/not-had per bid (with count and last date when had). Ideal ' +
        'for checking a whole venue menu at once. Run untappd_sync_user_beers first; the freshness block flags if ' +
        'coverage is incomplete.',
      annotations: toolAnnotations({ title: 'Batch-check many beers against the cache', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: {
        username: UsernameArg,
        bids: z.array(z.number().int().positive()).min(1).max(500).describe('Beer ids to check (1–500)'),
      },
    },
    async ({ username, bids }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const seen = new Set<number>();
      const results = [];
      let hadCount = 0;
      for (const bid of bids) {
        if (seen.has(bid)) continue;
        seen.add(bid);
        const r = await cache.hasHad(user, { bid });
        if (r.had) hadCount++;
        results.push({ bid, had: r.had, count: r.count, last_date: r.last_date, best_rating: r.best_rating, sources: r.sources });
      }
      return textResult({
        username: user,
        checked: seen.size,
        had: hadCount,
        not_had: seen.size - hadCount,
        results,
        freshness: await freshness(cache, user),
      });
    },
  );

  server.registerTool(
    'untappd_cache_not_had',
    {
      title: 'From a list of beers, return the ones a user has NOT had',
      description:
        'Given a list of beer ids, return only the ones the user has NOT had — the "what here is new to me?" filter ' +
        'for a venue menu, a brewery lineup, or a festival list. Consults BOTH cached sources; reads the cache only, ' +
        'NO API call. Returns the not-had bids (plus the had bids and counts) and cache freshness. Run ' +
        'untappd_sync_user_beers first; if coverage is incomplete the freshness caveat flags that a "not had" may be ' +
        'a false negative.',
      annotations: toolAnnotations({ title: 'From a list of beers, return the ones a user has NOT had', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: {
        username: UsernameArg,
        bids: z.array(z.number().int().positive()).min(1).max(500).describe('Candidate beer ids to filter (1–500)'),
      },
    },
    async ({ username, bids }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const seen = new Set<number>();
      const notHad: number[] = [];
      const had: number[] = [];
      for (const bid of bids) {
        if (seen.has(bid)) continue;
        seen.add(bid);
        if ((await cache.hasHad(user, { bid })).had) had.push(bid);
        else notHad.push(bid);
      }
      return textResult({
        username: user,
        checked: seen.size,
        not_had_count: notHad.length,
        had_count: had.length,
        not_had: notHad,
        had,
        freshness: await freshness(cache, user),
      });
    },
  );

  server.registerTool(
    'untappd_cache_query',
    {
      title: 'Query cached check-ins with filters',
      description:
        "Query a user's cached CHECK-INS by brewery, style, minimum rating, venue, and/or date range, with sorting " +
        'and a limit — from the cache only, NO API call. Reflects the detailed check-ins table (venue/date), which ' +
        'for non-self accounts is only the recent window; for full coverage of which beers a user has had, use ' +
        'untappd_cache_has_had / not_had instead. Run untappd_sync_checkins first.',
      annotations: toolAnnotations({ title: 'Query cached check-ins with filters', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: {
        username: UsernameArg,
        brewery_id: z.number().int().positive().optional().describe('Exact brewery id'),
        brewery: z.string().min(1).optional().describe('Case-insensitive substring match on brewery name'),
        style: z.string().min(1).optional().describe('Case-insensitive substring match on beer style (e.g. "IPA")'),
        min_rating: z.number().min(0).max(5).optional().describe('Only check-ins you rated at least this (0–5)'),
        venue: z.string().min(1).optional().describe('Case-insensitive substring match on venue name'),
        venue_id: z.number().int().positive().optional().describe('Exact venue id'),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only check-ins on/after this date (YYYY-MM-DD, UTC)'),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only check-ins on/before this date (YYYY-MM-DD, UTC)'),
        sort: z
          .enum(['recent', 'oldest', 'highest_rated', 'lowest_rated'])
          .optional()
          .describe('Sort order (default recent first)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (1–200, default 25)'),
      },
    },
    async ({ username, ...filters }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const rows = await cache.query(user, filters);
      return textResult({ username: user, count: rows.length, filters, results: rows, freshness: await freshness(cache, user) });
    },
  );

  server.registerTool(
    'untappd_top_not_had',
    {
      title: 'Top-rated beers a user has NOT had, from a candidate list',
      description:
        'The "what should I order off this tap list?" tool. From a list of candidate beer ids, return the top N the ' +
        'user has NOT yet had, ranked by Untappd global rating, with an optional style filter. Not-had filtering uses ' +
        'the cache only (both sources, no API call). Beer ratings/styles come from a metadata cache; a beer/info API ' +
        'call is made only on a cache miss or if the cached metadata is >30 days old, capped at api_budget calls per ' +
        'run (~100 calls/hour limit) — if more are needed it returns partial: true / another_run_needed: true, so ' +
        're-running fills the rest. Reports the same freshness/caveat block as untappd_cache_not_had. Omit username ' +
        'for your own account.',
      annotations: toolAnnotations({ title: 'Top-rated beers a user has NOT had, from a candidate list', readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        bids: z.array(z.number().int().positive()).min(1).max(100).describe('Candidate beer ids (1–100)'),
        top_n: z.number().int().min(1).max(10).optional().describe('How many top beers to return (default 2, max 10)'),
        style: z
          .string()
          .min(1)
          .optional()
          .describe('Case-insensitive substring filter; matches EITHER the beer style or its parent style (e.g. "ipa")'),
        api_budget: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max beer/info API calls this run for uncached/stale metadata (default 25). Keep modest to respect the ~100 calls/hour rate limit.'),
      },
    },
    async ({ username, bids, top_n, style, api_budget }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const topN = top_n ?? 2;
      const budget = api_budget ?? 25;
      const nowMs = Date.now();
      const nowIso = new Date().toISOString();

      // Dedupe candidates, then filter to not-had using the cache only (no API).
      const candidates = [...new Set(bids)];
      const notHad: number[] = [];
      for (const bid of candidates) {
        if (!(await cache.hasHad(user, { bid })).had) notHad.push(bid);
      }

      // Read cached metadata; a hit newer than the TTL is used as-is, otherwise
      // the bid needs a beer/info fetch.
      const metaByBid = new Map<number, BeerMeta>();
      for (const m of await cache.getBeerMeta(notHad)) metaByBid.set(m.bid, m);
      const haveMeta: BeerMeta[] = [];
      const needFetch: number[] = [];
      for (const bid of notHad) {
        const m = metaByBid.get(bid);
        if (m && m.fetched_at && nowMs - Date.parse(m.fetched_at) < BEER_META_TTL_MS) haveMeta.push(m);
        else needFetch.push(bid);
      }

      // Fetch missing/stale metadata up to the API budget; anything over the
      // budget (or after a rate limit) is deferred to a later run.
      const toFetch = needFetch.slice(0, budget);
      let deferred = needFetch.length - toFetch.length;
      let apiCalls = 0;
      let rateLimited = false;
      const fetched: BeerMeta[] = [];
      for (let i = 0; i < toFetch.length; i++) {
        const bid = toFetch[i];
        try {
          const data = await client.get<{ beer?: unknown }>(`/beer/info/${bid}`, { compact: 'true' });
          apiCalls++;
          const meta = beerMetaFrom((data as { beer?: unknown }).beer, undefined, nowIso);
          if (meta) fetched.push(meta);
        } catch (e) {
          if (e instanceof RateLimitError) {
            // Stop calling; the rest is deferred to a later run.
            rateLimited = true;
            deferred += toFetch.length - i;
            break;
          }
          // A single bad/unknown bid shouldn't sink the whole run — skip it.
        }
      }
      if (fetched.length) await cache.upsertBeerMeta(fetched);

      const available = [...haveMeta, ...fetched];
      const ratingOf = (m: BeerMeta): number => m.weighted_rating_score ?? m.rating_score ?? 0;

      // Style filter: substring against EITHER the beer style or its parent style.
      let matched = available;
      if (style !== undefined) {
        const s = style.toLowerCase();
        matched = available.filter(
          (m) => (m.style?.toLowerCase().includes(s) ?? false) || (m.parent_style?.toLowerCase().includes(s) ?? false),
        );
      }

      const ranked = matched
        .slice()
        .sort((a, b) => ratingOf(b) - ratingOf(a))
        .slice(0, topN)
        .map((m) => ({
          bid: m.bid,
          name: m.name,
          brewery: m.brewery,
          style: m.style,
          abv: m.abv,
          rating: m.weighted_rating_score ?? m.rating_score,
          rating_count: m.rating_count,
        }));

      const partial = deferred > 0;
      return textResult({
        username: user,
        ranked,
        summary: {
          candidates: candidates.length,
          not_had: notHad.length,
          style_matched: style !== undefined ? matched.length : null,
          api_calls_used: apiCalls,
          partial,
          another_run_needed: partial,
          ...(rateLimited ? { rate_limited: true } : {}),
        },
        freshness: await freshness(cache, user),
      });
    },
  );
}
