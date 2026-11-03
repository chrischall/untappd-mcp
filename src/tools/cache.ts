import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { RateLimitError, confirmTokenParam, createHelpfulError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { beerMetaFrom, DEFAULT_VISIT_RADIUS_M, type BeerMeta, type CacheStore, type SyncState, type VenueQuery } from '../cache/store.js';
import { syncCheckins } from '../cache/sync.js';
import { syncUserBeers } from '../cache/sync-beers.js';
import { syncUserVenues, VENUES_LIST, VENUES_MAX_PAGES_CAP, VENUES_REFRESH_LIST } from '../cache/sync-venues.js';
import { syncWishlist, WISHLIST_MAX_PAGES_CAP } from '../cache/sync-wishlist.js';
import { syncVenueDrinks, VENUE_DRINKS_DEFAULT_CALLS, VENUE_DRINKS_MAX_CALLS_CAP } from '../cache/venue-drinks.js';
import {
  DEFAULT_MULTI_USER_MODE,
  MAX_GROUP_USERS,
  MULTI_USER_MODES,
  multiHasHad,
  resolveUsers,
  type MultiUserMode,
} from '../cache/multi-user.js';
import { favoriteLookup } from '../cache/favorites.js';
import { CONFIRM_FLOW, confirmWrite } from './confirm.js';
import { clampToQuota } from '../quota.js';
import { rateLimitStatus } from '../ratelimit.js';

// Re-fetch cached beer metadata at most this often; a hit newer than this skips
// the beer/info API call.
const BEER_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * untappd_top_not_had's prefer_favorites boost, added to a beer's global rating
 * (0–5) for ranking only: a wishlisted beer (explicit intent) gets more than one
 * from a favorite brewery. Small enough that a clearly better beer still wins.
 */
export const WISHLIST_BOOST = 0.5;
export const FAVORITE_BREWERY_BOOST = 0.25;

/**
 * A source of the {@link CacheStore} to use for a request. Injected per
 * entrypoint so this module stays platform-neutral: the stdio server passes a
 * `node:sqlite` file cache; another deployment could pass a different
 * cache scoped to the authenticated operator.
 */
export type CacheProvider = () => CacheStore;

export const UsernameArg = z
  .string()
  .min(1)
  .optional()
  .describe('Untappd username. Omit to use your own configured account (UNTAPPD_USERNAME).');

/** Resolve the target username (raw, un-encoded) — explicit arg else configured login. */
export function resolveUser(username: string | undefined, loginName: string | null): string {
  const u = username ?? loginName;
  if (!u) {
    throw createHelpfulError('No username given and no configured account to fall back to.', {
      hint: 'Pass `username`, or set UNTAPPD_USERNAME so cache tools default to your own account.',
    });
  }
  return u;
}

/** Report the quota only when Untappd told us it (and say when it cut the budget). */
export function quotaFields(q: { quota_remaining: number | null; clamped: boolean }): Record<string, unknown> {
  if (q.quota_remaining === null) return {};
  return { quota_remaining: q.quota_remaining, ...(q.clamped ? { budget_clamped_to_quota: true } : {}) };
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
export async function freshness(cache: CacheStore, username: string): Promise<Record<string, unknown>> {
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

/** Several users' has-had freshness: every block, all-complete, and one caveat naming the incomplete users. */
export async function groupFreshness(cache: CacheStore, usernames: string[]): Promise<Record<string, unknown>> {
  const byUser: Record<string, Record<string, unknown>> = {};
  const incomplete: string[] = [];
  for (const u of usernames) {
    const f = await freshness(cache, u);
    byUser[u] = f;
    if (!f.coverage_complete) incomplete.push(u);
  }
  return {
    coverage_complete: incomplete.length === 0,
    by_user: byUser,
    ...(incomplete.length
      ? {
          caveat:
            `Has-had coverage is incomplete for ${incomplete.join(', ')} (see by_user) — a beer counted as not had by ` +
            'them may be a false negative. Run untappd_sync_user_beers for each until complete.',
        }
      : {}),
  };
}

const UsernamesArg = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_GROUP_USERS)
  .optional()
  .describe(
    `Check a GROUP of users (1–${MAX_GROUP_USERS}) instead of one — e.g. everyone at the table. Use instead of username; ` +
      'each must be synced (untappd_sync_user_beers).',
  );
const ModeArg = z
  .enum(MULTI_USER_MODES)
  .optional()
  .describe(
    'With usernames: "none_had" (default) keeps beers NONE of them has had (new to everyone); "any_not_had" keeps ' +
      'beers at least one of them has not had.',
  );

/**
 * Freshness block for venue-history reads (untappd_cache_has_visited): how much
 * of the user's user/venues list is cached, so a "not visited" can be flagged
 * as a possible false negative.
 */
export async function venueFreshness(cache: CacheStore, username: string): Promise<Record<string, unknown>> {
  const state = await cache.getListState(username, VENUES_LIST);
  const refresh = await cache.getListState(username, VENUES_REFRESH_LIST);
  const cached = await cache.userVenuesCount(username);
  const backfilled = state?.complete ?? false;
  // A cut-short incremental refresh means re-visited or new venues below its
  // cursor may be missing, so the history is not authoritative until it ends.
  const refreshing = backfilled && !!refresh && !refresh.complete;
  const complete = backfilled && !refreshing;
  const total = state?.total_count ?? null;
  const percent = pct(cached, total, complete);
  let caveat: string | undefined;
  if (!state?.last_synced_at && cached === 0) {
    caveat =
      "This user's venue history has never been synced — the cache is EMPTY. Run untappd_sync_user_venues first; results here are not authoritative.";
  } else if (refreshing) {
    caveat =
      'A venue-history refresh is unfinished — recently visited or new venues may be missing or show a stale recent_visit, so a "not visited" may be a false negative. Run untappd_sync_user_venues until another_run_needed is false.';
  } else if (!complete) {
    caveat = `Venue history incomplete (${percent !== null ? `~${percent}%` : 'unknown'} cached). A "not visited" may be a false negative — run untappd_sync_user_venues until another_run_needed is false.`;
  }
  return {
    last_synced_at: state?.last_synced_at ?? null,
    coverage_complete: complete,
    ...(refreshing ? { refresh_in_progress: true } : {}),
    cached_venues: cached,
    total_venues: total,
    percent,
    ...(caveat ? { caveat } : {}),
  };
}

/**
 * Register the check-in cache tools. `cacheProvider` supplies the backing store
 * (a `node:sqlite` file here) and is required so this module imports no
 * platform-specific code.
 */
export function registerCacheTools(server: McpServer, client: UntappdClient, cacheProvider: CacheProvider): void {
  server.registerTool(
    'untappd_cache_status',
    {
      title: 'Show the local cache location, schema and per-user coverage',
      description:
        'Diagnostics for the LOCAL check-in cache — NO API call. Returns the resolved cache file path, its size on ' +
        'disk (db + WAL), journal mode, schema version, the number of cached menu-line resolutions and beer-metadata ' +
        'rows, cached venues, and for every cached user: cached vs total distinct beers, cached check-ins, ' +
        'coverage_complete, the resume offset of an unfinished user/beers backfill, last_synced_at, and venue-history ' +
        'coverage (venues: cached vs total, complete, percent, next_offset; null if never synced). Also reports rate_limit: API calls ' +
        'made in the last hour (this process plus any other sharing the cache file), the ~100/hour limit, the ' +
        'estimated calls left, the raw X-Ratelimit-* headers (the v4 API sends Remaining: 0 on every success, so it ' +
        'is ignored until it reports a live value) and any 429 wait. Use it to confirm the cache persisted across ' +
        'restarts, to see how far a backfill has got, or to check whether a sync can run now.',
      annotations: toolAnnotations({ title: 'Show the local cache location, schema and per-user coverage', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: z.object({}),
    },
    async () => {
      const cache = cacheProvider();
      const stats = await cache.stats();
      // The file details only exist for a file-backed store (the node:sqlite
      // CheckinCache); another backend reports the logical stats alone.
      const file = (cache as Partial<{ fileInfo(): { path: string; bytes: number; journal_mode: string } }>).fileInfo?.();
      return minifiedResult({
        ...(file ? { cache_path: file.path, file_size_bytes: file.bytes, journal_mode: file.journal_mode } : {}),
        schema_version: stats.schema_version,
        resolution_cache_entries: stats.resolution_cache_entries,
        beer_meta_entries: stats.beer_meta_entries,
        venue_entries: stats.venue_entries,
        users: stats.users,
        rate_limit: await rateLimitStatus(client, cache),
      });
    },
  );

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
        'the whole history (cached rows are kept). Stops BEFORE the ~100 calls/hour rate limit (or cleanly on a 429) ' +
        'with stopped_for_rate_limit and rate_limit.resume_at — progress is saved; re-run after that time. Omit ' +
        'username for your own account.',
      annotations: toolAnnotations({ title: "Sync a user's check-ins into the cache", readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
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
      }),
    },
    async ({ username, max_pages, force_backfill }) => {
      const user = resolveUser(username, client.loginName);
      // Floor of 1: the shared catch-up/backfill page split (sync.ts) is only
      // defined for a budget of at least one page.
      const quota = clampToQuota(client, max_pages ?? 10, 1);
      const summary = await syncCheckins(client, cacheProvider(), user, {
        maxPages: quota.budget,
        force: force_backfill ?? false,
      });
      return minifiedResult({ ...summary, ...quotaFields(quota) });
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
        'untappd_cache_has_had / has_had_many / not_had tools. Stops BEFORE the ~100 calls/hour rate limit (or ' +
        'cleanly on a 429) with stopped_for_rate_limit and rate_limit.resume_at — progress is saved; re-run after ' +
        'that time. Omit username for your own account.',
      annotations: toolAnnotations({ title: "Sync a user's complete distinct-beers list into the cache", readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        username: UsernameArg,
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Pages (50 beers each) to fetch this run (default 10). Keep modest to respect the ~100 calls/hour rate limit.'),
      }),
    },
    async ({ username, max_pages }) => {
      const user = resolveUser(username, client.loginName);
      const quota = clampToQuota(client, max_pages ?? 10, 1);
      const summary = await syncUserBeers(client, cacheProvider(), user, quota.budget);
      return minifiedResult({ ...summary, ...quotaFields(quota) });
    },
  );

  server.registerTool(
    'untappd_sync_user_venues',
    {
      title: "Sync a user's complete venue history into the cache",
      description:
        "Fetch a user's COMPLETE venue history (every venue they've checked in at, with first/most-recent visit dates " +
        'and visit count) into the cache from user/venues. Unlike user/checkins — which only returns the ~50 most ' +
        'recent check-ins for anyone but yourself — user/venues pages any public/friend account\'s whole history, so ' +
        'this is how to answer "has this person been here?" (via untappd_cache_has_visited). Untappd serves 25 venues ' +
        'per page, so a 2,700-venue history is ~110 calls: resumable — fetches max_pages per call, saves progress ' +
        'after every page; run again until another_run_needed is false. Once complete, a re-run is a cheap refresh ' +
        'from the top that stops at the first page with no changed visits (a refresh cut short resumes where it ' +
        'stopped; another_run_needed stays true until it finishes). Stops BEFORE the ~100 calls/hour rate ' +
        'limit (or cleanly on a 429) with stopped_for_rate_limit and rate_limit.resume_at. Omit username for your own account.',
      annotations: toolAnnotations({ title: "Sync a user's complete venue history into the cache", readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        username: UsernameArg,
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(VENUES_MAX_PAGES_CAP)
          .optional()
          .describe('Pages (25 venues each) to fetch this run (default 10, max 50). Keep modest to respect the ~100 calls/hour rate limit.'),
      }),
    },
    async ({ username, max_pages }) => {
      const user = resolveUser(username, client.loginName);
      const quota = clampToQuota(client, max_pages ?? 10, 1);
      const summary = await syncUserVenues(client, cacheProvider(), user, quota.budget);
      return minifiedResult({ ...summary, ...quotaFields(quota) });
    },
  );

  server.registerTool(
    'untappd_sync_wishlist',
    {
      title: "Sync a user's wishlist into the cache",
      description:
        "Mirror a user's Untappd wishlist (user/wishlist) into the local cache, so pick tools can boost wishlisted " +
        'beers without an API call. Each sync is a full pass from the top (~25 beers per call; wishlists are small), ' +
        'adding new beers and — once the pass finishes — dropping ones no longer wishlisted (a partial pass never ' +
        'deletes). Resumable: saves progress every page; run again until another_run_needed is false. Stops BEFORE ' +
        'the ~100 calls/hour rate limit (or cleanly on a 429) with stopped_for_rate_limit and rate_limit.resume_at. ' +
        'Only reads Untappd — never changes the wishlist (that is untappd_wishlist_add / _remove). Omit username for ' +
        'your own account; another user\'s wishlist needs a public account or friendship.',
      annotations: toolAnnotations({ title: "Sync a user's wishlist into the cache", readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        username: UsernameArg,
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(WISHLIST_MAX_PAGES_CAP)
          .optional()
          .describe(`Pages (~25 beers each) to fetch this run (default 10, max ${WISHLIST_MAX_PAGES_CAP}).`),
      }),
    },
    async ({ username, max_pages }) => {
      const user = resolveUser(username, client.loginName);
      const quota = clampToQuota(client, max_pages ?? 10, 1);
      const summary = await syncWishlist(client, cacheProvider(), user, quota.budget);
      return minifiedResult({ ...summary, ...quotaFields(quota) });
    },
  );

  server.registerTool(
    'untappd_sync_venue_drinks',
    {
      title: 'Fetch what a user drank on their first/latest visit to each venue (opt-in)',
      description:
        'OPT-IN, costs API calls: for a user\'s cached venue history (run untappd_sync_user_venues first), fetch the ' +
        'FIRST and MOST-RECENT visit check-ins of each venue via checkin/view (works for any public check-in) and cache ' +
        'the beer + date — a PARTIAL "what did they drink there" (two check-ins per venue at most, never the full ' +
        'list). One call per check-in, most-visited venues first, at most max_calls per run (default ' +
        `${VENUE_DRINKS_DEFAULT_CALLS}, max ${VENUE_DRINKS_MAX_CALLS_CAP}); already-cached check-ins are never re-fetched, ` +
        'and deleted/private ones (404) are remembered and skipped. Narrow with venue_ids and which. Stops BEFORE the ' +
        '~100 calls/hour rate limit (or cleanly on a 429) with stopped_for_rate_limit and rate_limit.resume_at; run ' +
        'again until another_run_needed is false. Results appear in untappd_cache_has_visited under matches[].drinks. ' +
        'Stores only beer, brewery and date — never comments. Omit username for your own account.',
      annotations: toolAnnotations({
        title: 'Fetch what a user drank on their first/latest visit to each venue (opt-in)',
        readOnly: false,
        idempotent: false,
        openWorld: true,
        destructive: false,
      }),
      inputSchema: z.object({
        username: UsernameArg,
        max_calls: z
          .number()
          .int()
          .min(1)
          .max(VENUE_DRINKS_MAX_CALLS_CAP)
          .optional()
          .describe(`checkin/view calls this run (default ${VENUE_DRINKS_DEFAULT_CALLS}, max ${VENUE_DRINKS_MAX_CALLS_CAP}). Each is one of the ~100 hourly calls.`),
        venue_ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(100)
          .optional()
          .describe('Only these venues (from untappd_cache_has_visited). Default: every cached venue, most-visited first.'),
        which: z
          .enum(['both', 'first', 'recent'])
          .optional()
          .describe('Fetch each venue\'s first-visit check-in, most-recent one, or both (default both).'),
      }),
    },
    async ({ username, max_calls, venue_ids, which }) => {
      const user = resolveUser(username, client.loginName);
      const quota = clampToQuota(client, max_calls ?? VENUE_DRINKS_DEFAULT_CALLS, 1);
      const summary = await syncVenueDrinks(client, cacheProvider(), user, { maxCalls: quota.budget, venueIds: venue_ids, which });
      return minifiedResult({ ...summary, ...quotaFields(quota) });
    },
  );

  const VenueQueryArg = z.object({
    label: z.string().max(200).optional().describe('Your own name for this query, echoed back (e.g. "Coppertail, Tampa")'),
    venue_ids: z.array(z.number().int().positive()).max(100).optional().describe('Exact Untappd venue ids'),
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Venue name: matches a case-insensitive substring, or every significant word ("Green Bench Brewing" finds ' +
          '"Green Bench Brewing Co." and its "(duplicate of …)" copies)',
      ),
    city: z.string().min(1).max(100).optional().describe('Narrow a name/geo match to venues whose city contains this'),
    state: z.string().min(1).max(100).optional().describe('Narrow a name/geo match to venues whose state contains this (e.g. "FL")'),
    lat: z.number().min(-90).max(90).optional().describe('Latitude of a point; needs lng'),
    lng: z.number().min(-180).max(180).optional().describe('Longitude of a point; needs lat'),
    radius_m: z
      .number()
      .positive()
      .max(50_000)
      .optional()
      .describe(`Radius around lat/lng in metres (default ${DEFAULT_VISIT_RADIUS_M})`),
  });

  server.registerTool(
    'untappd_cache_has_visited',
    {
      title: 'Check if a user has been to a venue (from the cache)',
      description:
        'Answer "has this user been here?" for one or many places in ONE call, from the cached venue history only — ' +
        'NO API call. Each query matches by exact venue_ids, by name (case-insensitive substring or all significant ' +
        'words, optionally narrowed by city/state), and/or by lat/lng within radius_m (default 150 m); venue_ids are ' +
        'unioned with the name/geo match, and name + lat/lng together must both hold. Name/location matching matters ' +
        'because a brewery_id is NOT its taproom\'s venue_id, a brewery can have several venues, and Untappd keeps ' +
        '"… (duplicate of …)" venues — so expect, and check, several matches. Returns per query: visited, the matched ' +
        'venues (first_visit, recent_visit, total_count, is_duplicate, distance_m, and — once untappd_sync_venue_drinks ' +
        'has fetched them — drinks: the beer from the first/recent visit check-ins — and favorite {is_favorite, sources, ' +
        'reason}: derived from the visit history or added with untappd_favorite_add), and total_visits; plus a freshness ' +
        'block (last_synced_at, coverage_complete, caveat). Run untappd_sync_user_venues first.',
      annotations: toolAnnotations({ title: 'Check if a user has been to a venue (from the cache)', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: z.object({
        username: UsernameArg,
        queries: z.array(VenueQueryArg).min(1).max(50).describe('Places to check (1–50); each needs venue_ids, name, or lat+lng'),
        max_matches: z.number().int().min(1).max(50).optional().describe('Most matched venues listed per query (default 10)'),
      }),
    },
    async ({ username, queries, max_matches }) => {
      queries.forEach((q, i) => {
        const hasGeo = q.lat !== undefined || q.lng !== undefined;
        if (hasGeo && (q.lat === undefined || q.lng === undefined)) {
          throw createHelpfulError(`Query ${i + 1}: lat and lng must be given together.`, { hint: 'Pass both, or match by name / venue_ids instead.' });
        }
        if (!q.venue_ids?.length && q.name === undefined && !hasGeo) {
          throw createHelpfulError(`Query ${i + 1} has nothing to match on.`, {
            hint: 'Give venue_ids, a name (optionally with city/state), or lat + lng (optionally radius_m).',
          });
        }
      });
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const limit = max_matches ?? 10;
      const results = [];
      let visitedCount = 0;
      const found = [];
      for (const { label, ...q } of queries) found.push({ label, q, matches: await cache.findVisitedVenues(user, q as VenueQuery) });
      const favs = await favoriteLookup(cache, [user], { venue: found.flatMap((f) => f.matches.slice(0, limit).map((m) => m.venue_id)) });
      for (const { label, q, matches } of found) {
        if (matches.length > 0) visitedCount++;
        const shown = matches.slice(0, limit);
        const drinksByVenue = new Map<number, Array<Record<string, unknown>>>();
        for (const d of await cache.getVenueDrinks(user, shown.map((m) => m.venue_id))) {
          const list = drinksByVenue.get(d.venue_id) ?? [];
          list.push({ checkin_id: d.checkin_id, bid: d.bid, beer_name: d.beer_name, brewery_name: d.brewery_name, created_at: d.created_at });
          drinksByVenue.set(d.venue_id, list);
        }
        results.push({
          ...(label !== undefined ? { label } : {}),
          query: q,
          visited: matches.length > 0,
          match_count: matches.length,
          total_visits: matches.reduce((n, m) => n + (m.total_count ?? 0), 0),
          matches: shown.map((m) => ({
            venue_id: m.venue_id,
            name: m.name,
            category: m.category,
            city: m.city,
            state: m.state,
            country: m.country,
            ...(m.is_duplicate ? { is_duplicate: true } : {}),
            ...(m.distance_m !== undefined ? { distance_m: m.distance_m } : {}),
            first_visit: m.first_visit,
            recent_visit: m.recent_visit,
            total_count: m.total_count,
            first_checkin_id: m.first_checkin_id,
            recent_checkin_id: m.recent_checkin_id,
            ...(drinksByVenue.has(m.venue_id) ? { drinks: drinksByVenue.get(m.venue_id) } : {}),
            favorite: favs.get('venue', m.venue_id),
          })),
        });
      }
      return minifiedResult({
        username: user,
        checked: queries.length,
        visited_count: visitedCount,
        results,
        freshness: await venueFreshness(cache, user),
      });
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
        'last date, which sources matched, any detailed check-ins, and favorite {is_favorite, sources, reason} (rated ' +
        '≥4.25 / had ≥3 times, or added with untappd_favorite_add). Reports per-source freshness so you can ' +
        'caveat incomplete data. Requires bid or beer_name. Run untappd_sync_user_beers first for full coverage.',
      annotations: toolAnnotations({ title: 'Check if a user has had a beer (from the cache)', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: z.object({
        username: UsernameArg,
        bid: z.number().int().positive().optional().describe('Exact Untappd beer id to look for'),
        beer_name: z.string().min(1).optional().describe('Case-insensitive substring match on the beer name'),
      }),
    },
    async ({ username, bid, beer_name }) => {
      if (bid === undefined && beer_name === undefined) {
        throw createHelpfulError('Provide either bid or beer_name.', { hint: 'bid is exact; beer_name is a case-insensitive substring match.' });
      }
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const result = await cache.hasHad(user, { bid, beerName: beer_name });
      // By bid: that beer. By name only: any matched check-in's beer that is a favorite.
      const favBids = bid !== undefined ? [bid] : [...new Set(result.matches.map((m) => m.bid).filter((b): b is number => b !== null))];
      const favs = await favoriteLookup(cache, [user], { beer: favBids });
      const favorite = favBids.map((b) => favs.get('beer', b)).find((f) => f.is_favorite) ?? favs.get('beer', null);
      return minifiedResult({ username: user, query: { bid, beer_name }, ...result, favorite, freshness: await freshness(cache, user) });
    },
  );

  server.registerTool(
    'untappd_cache_has_had_many',
    {
      title: 'Batch-check many beers against the cache',
      description:
        'Cross-check a list of beer ids against a user\'s cached history in ONE call — NO API call. Consults BOTH ' +
        'sources (check-ins + distinct beers). Returns had/not-had per bid (with count and last date when had), plus ' +
        'favorite {is_favorite, sources, reason} per bid and brewery_favorite when its brewery (from cached beer ' +
        'metadata) is a favorite. Ideal ' +
        'for checking a whole venue menu at once. Pass usernames (instead of username) to check a GROUP: each bid ' +
        'then lists had_by / not_had_by and qualifies per mode — "none_had" (default: new to everyone) or ' +
        '"any_not_had" (at least one of them still needs it) — with qualifying_bids and a per-user freshness block. ' +
        'Run untappd_sync_user_beers first (for every user); the freshness block flags if coverage is incomplete.',
      annotations: toolAnnotations({ title: 'Batch-check many beers against the cache', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: z.object({
        username: UsernameArg,
        usernames: UsernamesArg,
        mode: ModeArg,
        bids: z.array(z.number().int().positive()).min(1).max(500).describe('Beer ids to check (1–500)'),
      }),
    },
    async ({ username, usernames, mode, bids }) => {
      const cache = cacheProvider();
      // One lookup for the whole batch (never per bid). Brewery ids come from cached beer metadata, when known.
      const favoritesFor = async (users: string[]) => {
        const breweryOf = new Map((await cache.getBeerMeta(bids)).map((b) => [b.bid, b.brewery_id]));
        const favs = await favoriteLookup(cache, users, { beer: bids, brewery: [...breweryOf.values()] });
        return (bid: number) => {
          const brewery = favs.get('brewery', breweryOf.get(bid));
          return { favorite: favs.get('beer', bid), ...(brewery.is_favorite ? { brewery_favorite: brewery } : {}) };
        };
      };
      if (usernames && usernames.length > 0) {
        const users = resolveUsers(username, usernames, client.loginName);
        const m: MultiUserMode = mode ?? DEFAULT_MULTI_USER_MODE;
        const group = await multiHasHad(cache, users, bids, m);
        const favOf = await favoritesFor(users);
        const results = [...group.values()].map((r) => ({ ...r, ...favOf(r.bid) }));
        const qualifying = results.filter((r) => r.qualifies).map((r) => r.bid);
        return minifiedResult({
          usernames: users,
          mode: m,
          checked: results.length,
          qualifying: qualifying.length,
          qualifying_bids: qualifying,
          results,
          freshness: await groupFreshness(cache, users),
        });
      }
      const user = resolveUser(username, client.loginName);
      const verdicts = await cache.hasHadMany(user, bids);
      const favOf = await favoritesFor([user]);
      const results = [];
      let hadCount = 0;
      for (const [bid, r] of verdicts) {
        if (r.had) hadCount++;
        results.push({ bid, had: r.had, count: r.count, last_date: r.last_date, best_rating: r.best_rating, sources: r.sources, ...favOf(bid) });
      }
      return minifiedResult({
        username: user,
        checked: verdicts.size,
        had: hadCount,
        not_had: verdicts.size - hadCount,
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
      inputSchema: z.object({
        username: UsernameArg,
        bids: z.array(z.number().int().positive()).min(1).max(500).describe('Candidate beer ids to filter (1–500)'),
      }),
    },
    async ({ username, bids }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const verdicts = await cache.hasHadMany(user, bids);
      const notHad: number[] = [];
      const had: number[] = [];
      for (const [bid, r] of verdicts) (r.had ? had : notHad).push(bid);
      return minifiedResult({
        username: user,
        checked: verdicts.size,
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
      inputSchema: z.object({
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
      }),
    },
    async ({ username, ...filters }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const rows = await cache.query(user, filters);
      return minifiedResult({ username: user, count: rows.length, filters, results: rows, freshness: await freshness(cache, user) });
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
        're-running fills the rest. A beer whose refresh is deferred or fails is still ranked on its older cached ' +
        'metadata and marked stale: true. Reports the same freshness/caveat block as untappd_cache_not_had. Omit username ' +
        'for your own account. For a GROUP pass usernames: mode "none_had" (default) ranks only beers new to everyone, ' +
        '"any_not_had" ranks beers at least one of them still needs (each ranked beer lists not_had_by / had_by). ' +
        `prefer_favorites (default true) lifts wishlisted beers (+${WISHLIST_BOOST}) and beers from a favorite brewery ` +
        `(+${FAVORITE_BREWERY_BOOST}) — derived or manual, any user's in a group; the wishlist needs untappd_sync_wishlist — ` +
        'and says so per beer (score, boosted_by, wishlisted, brewery_favorite/favorite).',
      annotations: toolAnnotations({ title: 'Top-rated beers a user has NOT had, from a candidate list', readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        username: UsernameArg,
        usernames: UsernamesArg,
        mode: ModeArg,
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
        prefer_favorites: z
          .boolean()
          .optional()
          .describe(
            `Boost beers on the wishlist (+${WISHLIST_BOOST}) or from a favorite brewery (+${FAVORITE_BREWERY_BOOST}) when ranking (default true). ` +
              'false ranks by global rating alone.',
          ),
      }),
    },
    async ({ username, usernames, mode, bids, top_n, style, api_budget, prefer_favorites }) => {
      const group = usernames !== undefined && usernames.length > 0;
      const users = resolveUsers(username, usernames, client.loginName);
      const groupMode: MultiUserMode = mode ?? DEFAULT_MULTI_USER_MODE;
      const cache = cacheProvider();
      const topN = top_n ?? 2;
      const quota = clampToQuota(client, api_budget ?? 25);
      const budget = quota.budget;
      const nowMs = Date.now();
      const nowIso = new Date().toISOString();

      // Dedupe candidates, then filter to not-had using the cache only (no API).
      // One user is the group case with one member (both modes mean "not had").
      const candidates = [...new Set(bids)];
      const verdicts = await multiHasHad(cache, users, candidates, groupMode);
      const notHad = candidates.filter((bid) => verdicts.get(bid)!.qualifies);

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
      let apiCalls = 0; // beer/info requests SENT (counts against the rate limit, successes or not)
      let errors = 0; // non-rate-limit failures — so a whole-run outage is distinguishable from "all bad bids"
      let rateLimited = false;
      const fetched: BeerMeta[] = [];
      for (let i = 0; i < toFetch.length; i++) {
        const bid = toFetch[i];
        apiCalls++;
        try {
          const data = await client.get<{ beer?: unknown }>(`/beer/info/${bid}`, { compact: 'true' });
          const meta = beerMetaFrom((data as { beer?: unknown }).beer, undefined, nowIso);
          if (meta) fetched.push(meta);
        } catch (e) {
          if (e instanceof RateLimitError) {
            // Hit the wall — defer this bid and the remainder to a later run.
            rateLimited = true;
            deferred += toFetch.length - i;
            break;
          }
          // A single bad/unknown/transient bid shouldn't sink the whole run —
          // skip it, but count it so a broad outage surfaces as errors > 0.
          errors++;
        }
      }
      if (fetched.length) await cache.upsertBeerMeta(fetched);

      // A bid whose refresh was deferred or failed still has its older cached
      // metadata — rank it (flagged stale) rather than silently dropping a beer
      // the cache knows about.
      const refreshed = new Set(fetched.map((m) => m.bid));
      const staleMeta: BeerMeta[] = [];
      for (const bid of needFetch) {
        const m = metaByBid.get(bid);
        if (m && !refreshed.has(bid)) staleMeta.push(m);
      }
      const staleBids = new Set(staleMeta.map((m) => m.bid));
      const available = [...haveMeta, ...fetched, ...staleMeta];
      const ratingOf = (m: BeerMeta): number => m.weighted_rating_score ?? m.rating_score ?? 0;

      // Style filter: substring against EITHER the beer style or its parent style.
      let matched = available;
      if (style !== undefined) {
        const s = style.toLowerCase();
        matched = available.filter(
          (m) => (m.style?.toLowerCase().includes(s) ?? false) || (m.parent_style?.toLowerCase().includes(s) ?? false),
        );
      }

      // Favorites (any group member's) and wishlists — cache only.
      const preferFavorites = prefer_favorites ?? true;
      const favs = await favoriteLookup(cache, users, { beer: matched.map((m) => m.bid), brewery: matched.map((m) => m.brewery_id) });
      const wishlisted = new Set<number>();
      for (const u of users) for (const w of await cache.getWishlist(u, matched.map((m) => m.bid))) wishlisted.add(w.bid);
      const boostsOf = (m: BeerMeta): Array<'wishlist' | 'favorite_brewery'> => {
        const out: Array<'wishlist' | 'favorite_brewery'> = [];
        if (wishlisted.has(m.bid)) out.push('wishlist');
        if (favs.isFavorite('brewery', m.brewery_id)) out.push('favorite_brewery');
        return out;
      };
      const scoreOf = (m: BeerMeta): number =>
        ratingOf(m) +
        (preferFavorites
          ? boostsOf(m).reduce((n, b) => n + (b === 'wishlist' ? WISHLIST_BOOST : FAVORITE_BREWERY_BOOST), 0)
          : 0);

      const ranked = matched
        .slice()
        .sort((a, b) => scoreOf(b) - scoreOf(a) || ratingOf(b) - ratingOf(a))
        .slice(0, topN)
        .map((m) => {
          const boosts = preferFavorites ? boostsOf(m) : [];
          const beerFav = favs.get('beer', m.bid);
          const breweryFav = favs.get('brewery', m.brewery_id);
          return {
          bid: m.bid,
          name: m.name,
          brewery: m.brewery,
          style: m.style,
          abv: m.abv,
          rating: m.weighted_rating_score ?? m.rating_score,
          rating_count: m.rating_count,
          ...(boosts.length ? { score: Number(scoreOf(m).toFixed(3)), boosted_by: boosts } : {}),
          ...(wishlisted.has(m.bid) ? { wishlisted: true } : {}),
          ...(beerFav.is_favorite ? { favorite: beerFav } : {}),
          ...(breweryFav.is_favorite ? { brewery_favorite: breweryFav } : {}),
          ...(staleBids.has(m.bid) ? { stale: true } : {}),
          ...(group
            ? {
                not_had_by: verdicts.get(m.bid)!.not_had_by,
                had_by: verdicts.get(m.bid)!.had_by.map((x) => x.username),
              }
            : {}),
          };
        });

      // Errors leave beers unranked (or ranked on stale data) just like a
      // deferral does, so a re-run is worth it in both cases.
      const partial = deferred > 0 || errors > 0;
      return minifiedResult({
        ...(group ? { usernames: users } : { username: users[0] }),
        ranked,
        summary: {
          ...(group ? { mode: groupMode } : {}),
          candidates: candidates.length,
          not_had: notHad.length,
          style_matched: style !== undefined ? matched.length : null,
          prefer_favorites: preferFavorites,
          api_calls_used: apiCalls,
          errors,
          stale: staleMeta.length,
          partial,
          another_run_needed: partial,
          ...(rateLimited ? { rate_limited: true } : {}),
          ...quotaFields(quota),
        },
        freshness: group ? await groupFreshness(cache, users) : await freshness(cache, users[0]),
      });
    },
  );

  server.registerTool(
    'untappd_cache_forget',
    {
      title: "Forget a user's cached check-ins",
      description:
        "Delete everything the LOCAL cache holds for one user — their cached check-ins (beer, rating, comment, venue, " +
        'date), distinct-beers list, venue history, wishlist copy, local favorites, venue drinks and sync state — e.g. after syncing a friend you no longer want a history of. Only ' +
        'the local cache is touched; nothing on Untappd changes, and a later sync can re-fetch it (manual favorites ' +
        'cannot be re-fetched). Shared beer, venue and brewery facts are kept. The preview shows the username and exactly how many rows will be removed. Omit username ' +
        `for your own account. ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: "Forget a user's cached check-ins", readOnly: false, idempotent: true, openWorld: false, destructive: true }),
      inputSchema: z.object({
        username: UsernameArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { username, confirmToken } = args;
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      // Bound into the token: if a sync adds rows after the preview, the
      // token no longer matches and the user re-confirms the real counts.
      const counts = {
        checkins: await cache.cachedCount(user),
        distinct_beers: await cache.distinctBeersCount(user),
      };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_cache_forget',
        action: 'untappd.cache_forget',
        message: `Review and confirm deleting ${user}'s data from the local Untappd cache:`,
        confirmToken,
        args,
        target: user.toLowerCase(),
        payload: { username: user.toLowerCase(), ...counts },
        preview: {
          action: 'cache_forget',
          username: user,
          ...counts,
          note: 'Deletes these rows from the LOCAL cache only; Untappd itself is unchanged and a re-sync can restore them.',
        },
      });
      if (gate) return gate;
      const removed = await cache.forgetUser(user);
      return minifiedResult({ forgotten: true, username: user, removed });
    },
  );
}
