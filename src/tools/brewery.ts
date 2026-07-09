import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';

export function registerBreweryTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_search_brewery',
    {
      title: 'Search Untappd breweries',
      description:
        'Search Untappd for breweries by name. Returns matches with their brewery id, location, type, and beer ' +
        'count. Feed a brewery id into untappd_brewery_info for full detail. Read-only.',
      annotations: toolAnnotations({ title: 'Search Untappd breweries', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        query: z.string().min(1).describe('Brewery name to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ query, limit, offset }) => {
      const data = await client.get('/search/brewery', { q: query, limit, offset });
      return textResult(data);
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
      inputSchema: {
        brewery_id: z.number().int().positive().describe('Untappd brewery id'),
        compact: z.boolean().optional().describe('Return a slimmer record without embedded activity (default false)'),
      },
    },
    async ({ brewery_id, compact }) => {
      const data = await client.get(`/brewery/info/${brewery_id}`, { compact: compact ? 'true' : undefined });
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_brewery_beers',
    {
      title: "Get a brewery's beer list",
      description:
        'Get the beers a brewery makes, by brewery id, with per-beer rating and check-in counts. Supports sorting ' +
        'and paging. Get an id from untappd_search_brewery. Read-only.',
      annotations: toolAnnotations({ title: "Get a brewery's beer list", readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        brewery_id: z.number().int().positive().describe('Untappd brewery id'),
        limit: z.number().int().min(1).max(50).optional().describe('Max beers (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
        sort: z
          .enum(['name', 'style', 'abv', 'rating', 'count'])
          .optional()
          .describe('Sort order (default by popularity)'),
      },
    },
    async ({ brewery_id, limit, offset, sort }) => {
      const data = await client.get(`/brewery/beer_list/${brewery_id}`, { limit, offset, sort });
      return textResult(data);
    },
  );
}
