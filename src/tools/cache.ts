import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, createHelpfulError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import type { CacheStore, SyncState } from '../cache/store.js';
import { syncCheckins } from '../cache/sync.js';
import { syncUserBeers } from '../cache/sync-beers.js';

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
}
