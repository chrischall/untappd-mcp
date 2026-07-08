import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';

const BidSchema = z.number().int().positive().describe('Untappd beer id (bid)');

export function registerBeerTools(server: McpServer): void {
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
      },
    },
    async ({ query, limit, offset, sort }) => {
      const data = await client.get('/search/beer', { q: query, limit, offset, sort });
      return textResult(data);
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
      return textResult(data);
    },
  );
}
