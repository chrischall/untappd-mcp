import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { createHelpfulError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { menuPick, venuePick, type PickDeps } from '../menu/pick.js';
import { freshness, quotaFields, resolveUser, UsernameArg, type CacheProvider } from './cache.js';
import { clampToQuota } from '../quota.js';
import { parseUntappdUrl } from './resolve.js';

const StyleFilter = z
  .string()
  .min(1)
  .optional()
  .describe('Case-insensitive substring filter on the beer style or parent style for the picks (e.g. "ipa", "stout").');
const TopN = z.number().int().min(1).max(10).optional().describe('How many picks to return (default 2, max 10).');
const ApiBudget = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Max Untappd API calls this run, shared by the cache sync, searches and rating lookups (default 60; Untappd allows ~100/hour). ' +
      'If it runs out, the result says another_run_needed and a re-run continues from what was cached.',
  );

/** Parse a venue argument: a bare id, a numeric string, or an untappd.com/v/<slug>/<id> URL. */
export function parseVenueArg(v: string | number): number {
  if (typeof v === 'number') return v;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const r = parseUntappdUrl(t);
  if (r?.type === 'venue' && r.id) return r.id;
  throw createHelpfulError(`"${v}" is not an Untappd venue id or venue URL.`, {
    hint: 'Pass the numeric venue id, or a URL like https://untappd.com/v/<slug>/<venue_id>. untappd_search_venue finds ids by name.',
  });
}

export function registerMenuTools(
  server: McpServer,
  client: UntappdClient,
  cacheProvider: CacheProvider,
  deps: PickDeps = {},
): void {
  server.registerTool(
    'untappd_menu_pick',
    {
      title: "Pick beers off a tap list that a user hasn't had",
      description:
        'One call from a tap list to "order this": give the raw menu lines as read from a photo and get back the ' +
        'top-rated beers the user has NOT had. It (1) refreshes the user\'s distinct-beers cache — an incremental ' +
        'refresh when the cache is complete, otherwise it backfills automatically within api_budget, no separate ' +
        'sync needed; (2) resolves each line to an Untappd beer (prices/punctuation stripped, scored on brewery + ' +
        'name match and check-in volume, venue_city as tie-breaker; resolutions are cached locally so repeat venues ' +
        'are instant); (3) treats "<Brewery> SEASONAL/ROTATING" as a list of possible beers (needs_confirmation) ' +
        'and "ROTATING CIDER"-style lines as unresolved ("ask bartender"); (4) checks every beer against the cache; ' +
        '(5) ranks the not-had ones by global rating. Returns picks, not_had, had, possible, unresolved, a sync ' +
        'block (what the refresh did) and freshness (coverage); if coverage is still incomplete a "not had" may be ' +
        'a false negative and another_run_needed is true. api_budget is also capped to the quota Untappd reports, ' +
        'when it reports one. Omit username for your own account.',
      annotations: toolAnnotations({ title: "Pick beers off a tap list that a user hasn't had", readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        username: UsernameArg,
        items: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(60)
          .describe('Raw menu lines as read from the menu, e.g. ["JACKALOPE FENNARIO IPA $7", "BLACK ABBEY SEASONAL", "ROTATING CIDER"].'),
        style_filter: StyleFilter,
        top_n: TopN,
        venue_city: z.string().min(1).optional().describe('City of the venue (e.g. "Nashville") — breaks ties between same-named beers toward local breweries.'),
        api_budget: ApiBudget,
        refresh_resolutions: z.boolean().optional().describe('Ignore cached line→beer matches and re-search every line (default false).'),
      }),
    },
    async ({ username, items, style_filter, top_n, venue_city, api_budget, refresh_resolutions }) => {
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const quota = clampToQuota(client, api_budget ?? 60);
      const out = await menuPick(
        client,
        cache,
        {
          username: user,
          items,
          styleFilter: style_filter,
          topN: top_n ?? 2,
          apiBudget: quota.budget,
          venueCity: venue_city,
          refreshResolutions: refresh_resolutions,
        },
        deps,
      );
      return minifiedResult({ username: user, ...out, ...quotaFields(quota), freshness: await freshness(cache, user) });
    },
  );

  server.registerTool(
    'untappd_venue_pick',
    {
      title: "Pick beers off a venue's Untappd menu that a user hasn't had",
      description:
        'Like untappd_menu_pick, but takes an Untappd venue (URL or id) instead of menu lines: it pulls the venue\'s ' +
        'FULL verified menu (walking every section page until complete, within api_budget), refreshes the user\'s ' +
        'distinct-beers cache (incremental, or an automatic backfill), checks every menu beer against it and ranks ' +
        'the not-had ones by global rating. Returns the same picks / not_had / had / sync shape plus a venue block ' +
        '(menu_complete is false only if the budget ran out mid-menu). A venue with no verified menu comes back ' +
        'unresolved — use untappd_menu_pick with the tap list instead. Omit username for your own account.',
      annotations: toolAnnotations({ title: "Pick beers off a venue's Untappd menu that a user hasn't had", readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        venue: z
          .union([z.string().min(1), z.number().int().positive()])
          .describe('Untappd venue URL (https://untappd.com/v/<slug>/<id>) or numeric venue id.'),
        username: UsernameArg,
        style_filter: StyleFilter,
        top_n: TopN,
        api_budget: ApiBudget,
      }),
    },
    async ({ venue, username, style_filter, top_n, api_budget }) => {
      const venueId = parseVenueArg(venue);
      const user = resolveUser(username, client.loginName);
      const cache = cacheProvider();
      const quota = clampToQuota(client, api_budget ?? 60);
      const out = await venuePick(
        client,
        cache,
        { username: user, venueId, styleFilter: style_filter, topN: top_n ?? 2, apiBudget: quota.budget },
        deps,
      );
      return minifiedResult({ username: user, ...out, ...quotaFields(quota), freshness: await freshness(cache, user) });
    },
  );
}
