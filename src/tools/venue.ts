import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';

export function registerVenueTools(server: McpServer): void {
  server.registerTool(
    'untappd_search_venue',
    {
      title: 'Search Untappd venues',
      description:
        'Search Untappd for venues (bars, breweries, restaurants) by name. Returns matches with their venue id, ' +
        'category, and location. Feed a venue id into untappd_venue_info for full detail. Read-only.',
      annotations: toolAnnotations({ title: 'Search Untappd venues', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        query: z.string().min(1).describe('Venue name to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1–50, default 25)'),
      },
    },
    async ({ query, limit }) => {
      const data = await client.get('/search/venue', { q: query, limit });
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_venue_info',
    {
      title: 'Get Untappd venue detail',
      description:
        'Get full detail for a venue by its Untappd venue id: category, address, contact, rating, total check-ins, ' +
        'and (unless compact) top beers and recent activity. Get an id from untappd_search_venue. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd venue detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        compact: z.boolean().optional().describe('Return a slimmer record without embedded activity (default false)'),
      },
    },
    async ({ venue_id, compact }) => {
      const data = await client.get(`/venue/info/${venue_id}`, { compact: compact ? 'true' : undefined });
      return textResult(data);
    },
  );
}
