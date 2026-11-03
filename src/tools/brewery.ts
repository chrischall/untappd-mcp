import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, resolveView, toolAnnotations, viewParam, viewResult } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { UNTAPPD_VIEWS, compactBreweryBeers, upstreamCompact } from '../compact.js';
import type { CacheStore } from '../cache/store.js';
import { BREWERY_BEERS_TTL_MS, getBreweryBeers } from '../cache/brewery-beers.js';
import { optionalCache } from './cache-optional.js';
import { favoriteLookup } from '../cache/favorites.js';

export function registerBreweryTools(
  server: McpServer,
  client: UntappdClient,
  cacheProvider?: () => CacheStore,
): void {
  const cacheOrNone = optionalCache(cacheProvider);
  server.registerTool(
    'untappd_search_brewery',
    {
      title: 'Search Untappd breweries',
      description:
        'Search Untappd for breweries by name. Returns matches with their brewery id, location, type, and beer ' +
        'count. Feed a brewery id into untappd_brewery_info for full detail. Read-only.',
      annotations: toolAnnotations({ title: 'Search Untappd breweries', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        query: z.string().min(1).describe('Brewery name to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      }),
    },
    async ({ query, limit, offset }) => {
      const data = await client.get('/search/brewery', { q: query, limit, offset });
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'untappd_brewery_info',
    {
      title: 'Get Untappd brewery detail',
      description:
        'Get full detail for a brewery by its Untappd brewery id: description, location, type, rating, total ' +
        'check-ins, and popular beers. Get an id from untappd_search_brewery. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd brewery detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        brewery_id: z.number().int().positive().describe('Untappd brewery id'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact also asks Untappd for its own slim record, dropping the embedded activity/list blocks; "full" returns everything.' }),
      }),
    },
    async ({ brewery_id, view }) => {
      const v = resolveView(view, UNTAPPD_VIEWS);
      const data = await client.get(`/brewery/info/${brewery_id}`, { compact: upstreamCompact(v) });
      return viewResult(v, data);
    },
  );

  server.registerTool(
    'untappd_brewery_beers',
    {
      title: "Get a brewery's beer list",
      description:
        'Get the beers a brewery makes, by brewery id, with per-beer global rating, check-in count, ABV, style and ' +
        'in_production. Supports sorting and paging. Get an id from untappd_search_brewery. Lists are CACHED locally ' +
        `for ${BREWERY_BEERS_TTL_MS / 86_400_000} days (source:"cache"|"api", fetched_at, expires_at): a fresh cached list answers ` +
        'without an API call — the default popularity order from the cached top-of-list, other sorts once the whole ' +
        'list is cached (sorted locally). refresh:true re-fetches. Untappd\'s per-beer have_had on this endpoint ' +
        'describes the AUTHENTICATED account, never the user you are asking about, so it is not cached or returned — ' +
        'use untappd_cache_has_had_many for any user. With the cache, the result carries favorite {is_favorite, sources, ' +
        'reason} for the brewery and on each favorite beer (derived from username\'s history or added with ' +
        'untappd_favorite_add; default your account). view:"full" always calls Untappd and returns its raw page. Read-only.',
      annotations: toolAnnotations({ title: "Get a brewery's beer list", readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        brewery_id: z.number().int().positive().describe('Untappd brewery id'),
        limit: z.number().int().min(1).max(50).optional().describe('Max beers (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
        sort: z
          .enum(['name', 'style', 'abv', 'rating', 'count'])
          .optional()
          .describe('Sort order (default by popularity)'),
        refresh: z.boolean().optional().describe('Re-fetch from Untappd even if a fresh cached list exists (default false)'),
        username: z
          .string()
          .min(1)
          .optional()
          .describe('Whose favorites to mark (cache only; default your configured account)'),
        view: viewParam(UNTAPPD_VIEWS, {
          note: 'compact keeps each beer\'s identity, rating and counts and drops the description, label URLs and the copy of this brewery repeated on every row; "full" returns Untappd\'s whole page (always fetched live).',
        }),
      }),
    },
    // Unlike its `/brewery/info` sibling above, this rung is NOT forwarded to
    // Untappd: `/brewery/beer_list/` is not one of the endpoints documented to
    // honour an upstream `compact`, and sending an unverified parameter to see
    // what happens is not a rung. The projection is entirely ours and is
    // grounded on a live capture — see `compactBreweryBeer`.
    async ({ brewery_id, limit, offset, sort, refresh, username, view }) => {
      const v = resolveView(view, UNTAPPD_VIEWS);
      const cache = cacheOrNone();
      if (!cache) {
        const data = await client.get(`/brewery/beer_list/${brewery_id}`, { limit, offset, sort });
        return viewResult(v, v === 'compact' ? compactBreweryBeers(data) : data);
      }
      // view:"full" wants Untappd's raw page, so it always fetches (and seeds the cache).
      const r = await getBreweryBeers(client, cache, brewery_id, { limit, offset, sort, refresh: refresh || v === 'full' });
      if (v === 'full') return viewResult(v, r.raw);
      // Favorites are applied on read (never cached): the brewery itself, and any favorite beer.
      const user = username ?? client.loginName;
      const favs = user ? await favoriteLookup(cache, [user], { brewery: [brewery_id], beer: r.beers.map((b) => b.bid) }) : null;
      return viewResult(v, {
        brewery_id: r.brewery_id,
        brewery_name: r.brewery_name,
        total_count: r.total_count,
        source: r.source,
        fetched_at: r.fetched_at,
        expires_at: r.expires_at,
        ...(favs ? { favorite: favs.get('brewery', brewery_id) } : {}),
        beers: {
          count: r.beers.length,
          items: r.beers.map((b) => ({
            bid: b.bid,
            name: b.beer_name,
            style: b.style,
            abv: b.abv,
            rating: b.rating_score,
            rating_count: b.rating_count,
            checkin_count: b.checkin_count,
            in_production: b.in_production,
            ...(favs?.isFavorite('beer', b.bid) ? { favorite: favs.get('beer', b.bid) } : {}),
          })),
        },
      });
    },
  );
}
