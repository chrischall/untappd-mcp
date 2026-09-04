import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveView, toolAnnotations, viewParam, viewResult } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactBeerSearch, compactCheckins, UNTAPPD_VIEWS, upstreamCompact } from '../compact.js';
import { beerMetaFrom, type BeerMeta, type CacheStore } from '../cache/store.js';

const BidSchema = z.number().int().positive().describe('Untappd beer id (bid)');

/**
 * Opportunistically seed the beer-metadata cache from detail we already fetched,
 * so untappd_top_not_had can answer for these beers without another API call.
 * Best-effort: any failure is swallowed so it never affects the read result.
 */
async function seedBeerMeta(
  cache: (() => CacheStore) | undefined,
  beers: Array<{ beer: unknown; brewery?: unknown }>,
): Promise<void> {
  if (!cache) return;
  try {
    const now = new Date().toISOString();
    const rows = beers
      .map((b) => beerMetaFrom(b.beer, b.brewery, now))
      .filter((m): m is BeerMeta => m !== null);
    if (rows.length) await cache().upsertBeerMeta(rows);
  } catch {
    /* best-effort seeding — never break the read */
  }
}

export function registerBeerTools(server: McpServer, client: UntappdClient, cache?: () => CacheStore): void {
  server.registerTool(
    'untappd_search_beer',
    {
      title: 'Search Untappd beers',
      description:
        'Search Untappd for beers by name (optionally "Brewery Beer"). Returns ranked matches with their ' +
        'beer id (bid), brewery, style, ABV, IBU, and global rating. Feed a bid into untappd_beer_info for full ' +
        'detail. Read-only.',
      annotations: toolAnnotations({ title: 'Search Untappd beers', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        query: z.string().min(1).describe('Beer name to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
        sort: z
          .enum(['checkin', 'name', 'count'])
          .optional()
          .describe('Sort order: checkin (relevance, default), name, or count'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact projects each match to {bid, name, style, abv, ibu, brewery, checkin_count, have_had}; "full" returns Untappd\'s whole ~1.2 KB search item, including the long beer_description and the nested brewery record.' }),
      },
    },
    async ({ query, limit, offset, sort, view }) => {
      const data = await client.get('/search/beer', { q: query, limit, offset, sort });
      const items = (data as { beers?: { items?: Array<{ beer?: unknown; brewery?: unknown }> } })?.beers?.items;
      if (Array.isArray(items)) {
        await seedBeerMeta(cache, items.map((i) => ({ beer: i.beer, brewery: i.brewery })));
      }
      const v = resolveView(view, UNTAPPD_VIEWS);
      return viewResult(v, v === 'compact' ? compactBeerSearch(data) : data);
    },
  );

  server.registerTool(
    'untappd_beer_info',
    {
      title: 'Get Untappd beer detail',
      description:
        'Get full detail for a beer by its Untappd beer id (bid): description, style, ABV, IBU, brewery, rating, ' +
        'total check-in count, and — on view:"full" — recent activity. Get a bid from untappd_search_beer. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd beer detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        bid: BidSchema,
        // No local projection here: compact is forwarded to Untappd as its OWN
        // `compact=true`, which drops the embedded recent-activity block server
        // side. What comes back is passed through on both rungs.
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact asks Untappd for its own slim record, dropping the embedded recent-activity (media/check-in) block server side; "full" returns the whole record including that activity. No local projection — the beer fields themselves are identical on both rungs.' }),
      },
    },
    async ({ bid, view }) => {
      const v = resolveView(view, UNTAPPD_VIEWS);
      const data = await client.get(`/beer/info/${bid}`, { compact: upstreamCompact(v) });
      await seedBeerMeta(cache, [{ beer: (data as { beer?: unknown })?.beer }]);
      return viewResult(v, data);
    },
  );

  server.registerTool(
    'untappd_beer_activity',
    {
      title: 'Get recent check-ins for a beer',
      description:
        'Get the recent public check-ins for a beer by its bid — who drank it, their rating, comment, and venue. ' +
        'Page backwards with max_id (the pagination.max_id from a prior call). Read-only.',
      annotations: toolAnnotations({ title: 'Get recent check-ins for a beer', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {
        bid: BidSchema,
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact projects each check-in to {id, user, beer, brewery, venue, rating, comment, toast/comment counts}; "full" returns Untappd\'s whole ~5 KB record.' }),
      },
    },
    async ({ bid, limit, max_id, view }) => {
      const data = await client.get(`/beer/checkins/${bid}`, { limit, max_id });
      const v = resolveView(view, UNTAPPD_VIEWS);
      return viewResult(v, v === 'compact' ? compactCheckins(data) : data);
    },
  );
}
