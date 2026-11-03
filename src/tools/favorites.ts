import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { FAVORITE_KINDS } from '../cache/store.js';
import { DEFAULT_FAVORITE_THRESHOLDS, FAVORITE_SOURCES, listFavorites, type FavoriteThresholds } from '../cache/favorites.js';
import { UsernameArg, freshness, resolveUser, venueFreshness, type CacheProvider } from './cache.js';

const D = DEFAULT_FAVORITE_THRESHOLDS;

/** Every derived-favorite threshold as an optional parameter (defaults = the spec). */
export const FavoriteThresholdsArg = z
  .object({
    venue_min_checkins: z.number().int().min(1).optional().describe(`Venue: at least this many check-ins (default ${D.venue_min_checkins})`),
    venue_min_months: z.number().int().min(1).optional().describe(`…or visits spanning at least this many distinct months (default ${D.venue_min_months})`),
    brewery_min_beers: z.number().int().min(1).optional().describe(`Brewery: at least this many beers had… (default ${D.brewery_min_beers})`),
    brewery_min_avg_rating: z.number().min(0).max(5).optional().describe(`…with at least this average rating (default ${D.brewery_min_avg_rating})`),
    brewery_min_beers_any_rating: z.number().int().min(1).optional().describe(`…or at least this many beers regardless of rating (default ${D.brewery_min_beers_any_rating})`),
    beer_min_rating: z.number().min(0).max(5).optional().describe(`Beer: rated at least this (default ${D.beer_min_rating})`),
    beer_min_times_had: z.number().int().min(1).optional().describe(`…or had at least this many times (default ${D.beer_min_times_had})`),
  })
  .optional()
  .describe('Override the derived-favorite thresholds (each optional; omitted ones keep their defaults).');

const KindArg = z.enum(FAVORITE_KINDS).describe('What the id is: a beer (bid), brewery (brewery_id) or venue (venue_id)');
const IdArg = z.number().int().positive().describe('The Untappd bid / brewery_id / venue_id');
const LOCAL_ONLY = 'Local to the cache — NEVER writes to Untappd (Untappd has no favorites API for this).';

/** untappd_favorite_add / _remove / untappd_favorites_list — the local favorites table plus derived favorites. */
export function registerFavoriteTools(server: McpServer, client: UntappdClient, cacheProvider: CacheProvider): void {
  server.registerTool(
    'untappd_favorite_add',
    {
      title: 'Mark a beer, brewery or venue as a favorite (local)',
      description:
        'Add a MANUAL favorite — a beer, brewery or venue — with an optional note, to the local cache. ' +
        `${LOCAL_ONLY} Re-adding an existing favorite updates its note (omit note to keep it) and keeps its ` +
        'created_at. Manual favorites show in untappd_favorites_list (source "manual") and as the `favorite` field on ' +
        'has_had, has_had_many, has_visited, brewery_beers, venue_menu, top_not_had and trip_check results; a favorite brewery also boosts its ' +
        'beers in untappd_top_not_had. Omit username for your own account.',
      annotations: toolAnnotations({ title: 'Mark a beer, brewery or venue as a favorite (local)', readOnly: false, idempotent: true, openWorld: false, destructive: false }),
      inputSchema: z.object({
        username: UsernameArg,
        kind: KindArg,
        id: IdArg,
        note: z.string().max(500).optional().describe('Why it is a favorite (shown as the reason)'),
      }),
    },
    async ({ username, kind, id, note }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const r = await cache.addFavorite(user, kind, id, note, new Date().toISOString());
      const [row] = await cache.getManualFavorites(user, { kind, ids: [id] });
      return minifiedResult({ ...r, username: user, kind, id, name: row?.name ?? null, local_only: true });
    },
  );

  server.registerTool(
    'untappd_favorite_remove',
    {
      title: 'Remove a manual favorite (local)',
      description:
        `Remove a MANUAL favorite (beer, brewery or venue) from the local cache. ${LOCAL_ONLY} Returns removed:false ` +
        'when there was none. A DERIVED favorite (from the user\'s history) cannot be removed — it is computed from ' +
        'the thresholds; change them in untappd_favorites_list instead. Omit username for your own account.',
      annotations: toolAnnotations({ title: 'Remove a manual favorite (local)', readOnly: false, idempotent: true, openWorld: false, destructive: false }),
      inputSchema: z.object({ username: UsernameArg, kind: KindArg, id: IdArg }),
    },
    async ({ username, kind, id }) => {
      const user = resolveUser(username, client.loginName);
      const removed = await cacheProvider().removeFavorite(user, kind, id);
      return minifiedResult({ removed, username: user, kind, id, local_only: true });
    },
  );

  server.registerTool(
    'untappd_favorites_list',
    {
      title: "List a user's favorite beers, breweries and venues",
      description:
        "List a user's favorites from the cache only — NO API call. Each item appears ONCE with every source that " +
        'names it (sources: "derived" = qualifies from their cached history, "manual" = added with ' +
        'untappd_favorite_add, "untappd" = a brewery the user likes/follows on Untappd, mirrored by ' +
        'untappd_sync_brewery_likes — breweries only: Untappd has no followed/favorite venue list) and a reason ' +
        '("liked on Untappd (since 2021-03)", "12 check-ins since 2015", "avg 4.1 across 9 beers", "manual: <note>"). ' +
        'Derived rules, each ' +
        `overridable via thresholds: venue = ≥${D.venue_min_checkins} check-ins OR visits spanning ≥${D.venue_min_months} distinct ` +
        `months (ranked by check-ins); brewery = ≥${D.brewery_min_beers} beers had AND avg rating ≥${D.brewery_min_avg_rating}, OR ` +
        `≥${D.brewery_min_beers_any_rating} beers (ranked by count blended with rating); beer = rated ≥${D.beer_min_rating} OR had ` +
        `≥${D.beer_min_times_had} times. Derived favorites are only as complete as the syncs behind them ` +
        '(untappd_sync_user_venues, untappd_sync_user_beers); "untappd" ones as the last untappd_sync_brewery_likes ' +
        '(freshness.brewery_likes). Filter by kind and source. Omit username for your own account.',
      annotations: toolAnnotations({ title: "List a user's favorite beers, breweries and venues", readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: z.object({
        username: UsernameArg,
        kind: z.enum(FAVORITE_KINDS).optional().describe('Only this kind (default all three)'),
        source: z.enum(FAVORITE_SOURCES).optional().describe('Only favorites carrying this source'),
        thresholds: FavoriteThresholdsArg,
        limit: z.number().int().min(1).max(500).optional().describe('Most items per kind (default 50)'),
      }),
    },
    async ({ username, kind, source, thresholds, limit }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const all = await listFavorites(cache, user, { kind, source, thresholds: thresholds as Partial<FavoriteThresholds> | undefined });
      const likes = await cache.breweryLikesCoverage(user);
      const max = limit ?? 50;
      const counts: Record<string, number> = {};
      const favorites = all.filter((f) => {
        counts[f.kind] = (counts[f.kind] ?? 0) + 1;
        return counts[f.kind] <= max;
      });
      return minifiedResult({
        username: user,
        counts,
        favorites,
        thresholds: { ...DEFAULT_FAVORITE_THRESHOLDS, ...Object.fromEntries(Object.entries(thresholds ?? {}).filter(([, v]) => v !== undefined)) },
        freshness: {
          beers: await freshness(cache, user),
          venues: await venueFreshness(cache, user),
          brewery_likes: likes,
          ...((source === 'untappd' || source === undefined) && (kind === undefined || kind === 'brewery')
            ? {
                untappd_source: likes?.complete
                  ? 'Untappd brewery likes are mirrored; "untappd" covers breweries only (Untappd has no favorite venue list).'
                  : 'Untappd brewery likes are not (fully) synced — run untappd_sync_brewery_likes; until then "untappd" favorites may be missing.',
              }
            : {}),
        },
      });
    },
  );
}
