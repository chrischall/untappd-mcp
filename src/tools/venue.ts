import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactCheckins } from '../compact.js';

export function registerVenueTools(server: McpServer, client: UntappdClient): void {
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

  server.registerTool(
    'untappd_venue_by_foursquare',
    {
      title: 'Look up an Untappd venue by Foursquare id',
      description:
        'Resolve a Foursquare venue id to its Untappd venue. Useful to turn a foursquare_id (e.g. from a check-in) ' +
        'into an Untappd venue you can pass to untappd_venue_info / untappd_venue_activity. Read-only.',
      annotations: toolAnnotations({ title: 'Look up an Untappd venue by Foursquare id', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        foursquare_id: z.string().min(1).describe('Foursquare venue id'),
      },
    },
    async ({ foursquare_id }) => {
      const data = await client.get(`/venue/foursquare_lookup/${encodeURIComponent(foursquare_id)}`);
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_venue_activity',
    {
      title: 'Get recent check-ins at a venue',
      description:
        'Get the recent public check-ins at a venue by its id — who was there, what they drank, and their ratings. ' +
        'Page backwards with max_id (the pagination.max_id from a prior call). Read-only.',
      annotations: toolAnnotations({ title: 'Get recent check-ins at a venue', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        compact: z
          .boolean()
          .optional()
          .describe('Project each check-in to a slim summary to save context (default false)'),
      },
    },
    async ({ venue_id, limit, max_id, compact }) => {
      const data = await client.get(`/venue/checkins/${venue_id}`, { limit, max_id });
      return textResult(compact ? compactCheckins(data) : data);
    },
  );
}
