import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactBeerSearch, compactCheckins } from '../compact.js';
import { beerMetaFrom, type BeerMeta, type CacheStore } from '../cache/store.js';

const BidSchema = z.number().int().positive().describe('Untappd beer id (bid)');

const CompactCheckins = z
  .boolean()
  .optional()
  .describe('Project each check-in to a slim summary (id, user, beer, rating, comment, venue, toast/comment counts) to save context (default false)');

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
        compact: z
          .boolean()
          .optional()
          .describe('Project each result to a slim summary (bid, name, brewery, style, abv, ibu, counts) to save context (default false)'),
      },
    },
    async ({ query, limit, offset, sort, compact }) => {
      const data = await client.get('/search/beer', { q: query, limit, offset, sort });
      const items = (data as { beers?: { items?: Array<{ beer?: unknown; brewery?: unknown }> } })?.beers?.items;
      if (Array.isArray(items)) {
        await seedBeerMeta(cache, items.map((i) => ({ beer: i.beer, brewery: i.brewery })));
      }
      return textResult(compact ? compactBeerSearch(data) : data);
    },
  );

  server.registerTool(
    'untappd_beer_info',
    {
      title: 'Get Untappd beer detail',
      description:
        'Get full detail for a beer by its Untappd beer id (bid): description, style, ABV, IBU, brewery, rating, ' +
        'total check-in count, and (unless compact) recent activity. Get a bid from untappd_search_beer. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd beer detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        bid: BidSchema,
        compact: z
          .boolean()
          .optional()
          .describe('Return a slimmer record without the embedded recent-activity lists (default false)'),
      },
    },
    async ({ bid, compact }) => {
      const data = await client.get(`/beer/info/${bid}`, { compact: compact ? 'true' : undefined });
      await seedBeerMeta(cache, [{ beer: (data as { beer?: unknown })?.beer }]);
      return textResult(data);
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
        compact: CompactCheckins,
      },
    },
    async ({ bid, limit, max_id, compact }) => {
      const data = await client.get(`/beer/checkins/${bid}`, { limit, max_id });
      return textResult(compact ? compactCheckins(data) : data);
    },
  );
}
