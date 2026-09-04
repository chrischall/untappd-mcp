import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, resolveView, toolAnnotations, viewParam, viewResult } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactCheckins, UNTAPPD_VIEWS } from '../compact.js';

export function registerDiscoverTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_trending',
    {
      title: 'Get trending beers',
      description:
        'Get the beers trending on Untappd right now, split into macro (big/widely-available) and micro ' +
        '(craft/independent) lists. Read-only.',
      annotations: toolAnnotations({ title: 'Get trending beers', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      const data = await client.get('/beer/trending');
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'untappd_notifications',
    {
      title: 'Get your Untappd notifications',
      description:
        'Get your Untappd notifications — toasts, comments, friend requests, and badges earned on YOUR account, ' +
        'plus news items. Read-only.',
      annotations: toolAnnotations({ title: 'Get your Untappd notifications', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max notifications (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ limit, offset }) => {
      const data = await client.get('/notifications', { limit, offset });
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'untappd_local_checkins',
    {
      title: 'Get nearby Untappd check-ins',
      description:
        'Get recent check-ins near a location (lat/lng) — what people are drinking nearby right now. Optionally ' +
        'widen the search radius. Read-only.',
      annotations: toolAnnotations({ title: 'Get nearby Untappd check-ins', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {
        lat: z.number().min(-90).max(90).describe('Latitude of the location'),
        lng: z.number().min(-180).max(180).describe('Longitude of the location'),
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        radius: z.number().int().min(1).max(25).optional().describe('Search radius (default per Untappd)'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact projects each check-in to {id, user, beer, brewery, venue, rating, comment, toast/comment counts}; "full" returns Untappd\'s whole ~5 KB record.' }),
      },
    },
    async ({ lat, lng, limit, radius, view }) => {
      const data = await client.get('/thepub/local', { lat, lng, limit, radius });
      const v = resolveView(view, UNTAPPD_VIEWS);
      return viewResult(v, v === 'compact' ? compactCheckins(data) : data);
    },
  );
}
