import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, createHelpfulError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import type { CacheStore, SyncState } from '../cache/store.js';
import { syncCheckins } from '../cache/sync.js';

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

/**
 * Freshness block attached to every cache READ result so the model can caveat
 * incomplete data: whether the cache has been synced, how complete the backfill
 * is, and a plain-language warning when a "not had" answer might be a false
 * negative.
 */
async function freshness(cache: CacheStore, username: string): Promise<Record<string, unknown>> {
  const state: SyncState | undefined = await cache.getState(username);
  const cached = await cache.cachedCount(username);
  const backfillComplete = state?.backfill_complete ?? false;
  const percent =
    state?.total_checkins && state.total_checkins > 0
      ? Math.min(100, Math.round((cached / state.total_checkins) * 100))
      : backfillComplete
        ? 100
        : null;
  const catchupInProgress = (state?.catchup_max_id ?? null) !== null;
  let caveat: string | undefined;
  if (!state || state.last_synced_at === null) {
    caveat = 'This user has never been synced — the cache is EMPTY. Run untappd_sync_checkins first; results here are not authoritative.';
  } else if (catchupInProgress) {
    caveat = 'A batch of the newest check-ins is still being caught up (last sync ran out of pages). Recent check-ins may be missing — run untappd_sync_checkins again to finish.';
  } else if (!backfillComplete) {
    caveat = `Backfill is incomplete${percent !== null ? ` (~${percent}% of history cached)` : ''}. A "not found" result may be a false negative for older check-ins — run untappd_sync_checkins again to keep backfilling.`;
  }
  return {
    last_synced_at: state?.last_synced_at ?? null,
    backfill_complete: backfillComplete,
    catchup_in_progress: catchupInProgress,
    backfill_percent: percent,
    cached_checkins: cached,
    distinct_beers: await cache.distinctBeerCount(username),
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
      title: 'Sync Untappd check-ins into the cache',
      description:
        "Fetch a user's check-ins into a persistent cache so history can be queried without paging the API. " +
        'Incremental (stops once it reaches already-cached check-ins) and resumable: if the backfill is not yet ' +
        'complete it pages backwards up to max_pages per call and persists progress after every page, so run it ' +
        'repeatedly until another_run_needed is false. Syncing another user requires their account be public or a ' +
        'friend. Omit username for your own account.',
      annotations: toolAnnotations({ title: 'Sync Untappd check-ins into the cache', readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Total pages (50 check-ins each) to fetch this run, incremental + backfill (default 10). Keep modest to respect the ~100 calls/hour rate limit.'),
      },
    },
    async ({ username, max_pages }) => {
      const user = resolveUser(username, client.loginName);
      const summary = await syncCheckins(client, cacheProvider(), user, max_pages ?? 10);
      return textResult(summary);
    },
  );

  server.registerTool(
    'untappd_cache_has_had',
    {
      title: 'Check if a user has had a beer (from the cache)',
      description:
        'Answer "has this user ever checked in this beer?" from the cache only — NO API call. Match by exact ' +
        'bid, or by a case-insensitive substring of the beer name. Returns whether they had it, how many times, the ' +
        "best rating, the last date, and the matching check-ins. Always reports cache freshness so you can caveat " +
        'incomplete data. Requires bid or beer_name. Run untappd_sync_checkins first.',
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
        'Cross-check a list of beer ids against a user\'s cached history in ONE call — NO API call. Returns had/not-had ' +
        'per bid (with count and last date when had). Ideal for checking a whole venue menu at once. Run ' +
        'untappd_sync_checkins first; the freshness block flags if the cache is incomplete.',
      annotations: toolAnnotations({ title: 'Batch-check many beers against the cache', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: {
        username: UsernameArg,
        bids: z.array(z.number().int().positive()).min(1).max(500).describe('Beer ids to check (1–500)'),
      },
    },
    async ({ username, bids }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      // De-dupe the input so a repeated bid is looked up once.
      const seen = new Set<number>();
      const results = [];
      let hadCount = 0;
      for (const bid of bids) {
        if (seen.has(bid)) continue;
        seen.add(bid);
        const r = await cache.hasHad(user, { bid });
        if (r.had) hadCount++;
        results.push({ bid, had: r.had, count: r.count, last_date: r.last_date, best_rating: r.best_rating });
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
    'untappd_cache_query',
    {
      title: 'Query cached check-ins with filters',
      description:
        "Query a user's cached check-ins by brewery, style, minimum rating, venue, and/or date range, with sorting " +
        'and a limit — from the cache only, NO API call. Returns the matching check-ins plus cache freshness. ' +
        'Run untappd_sync_checkins first.',
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
