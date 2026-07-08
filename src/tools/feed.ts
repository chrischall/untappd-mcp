import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { compactCheckins } from '../compact.js';

export function registerFeedTools(server: McpServer): void {
  server.registerTool(
    'untappd_activity_feed',
    {
      title: 'Get Untappd friend activity feed',
      description:
        'Get your Untappd friend activity feed — the recent check-ins from people you follow, newest first. Page ' +
        'backwards with max_id (the pagination.max_id from a prior call). Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd friend activity feed', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        compact: z
          .boolean()
          .optional()
          .describe('Project each check-in to a slim summary to save context (default false)'),
      },
    },
    async ({ limit, max_id, compact }) => {
      const data = await client.get('/checkin/recent', { limit, max_id });
      return textResult(compact ? compactCheckins(data) : data);
    },
  );

  server.registerTool(
    'untappd_checkin_info',
    {
      title: 'Get Untappd check-in detail',
      description:
        'Get full detail for a single check-in by its id: the beer, rating, comment, photos, venue, badges earned, ' +
        'toasts, and comments. Get a check-in id from a feed or user-checkins result. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd check-in detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        checkin_id: z.number().int().positive().describe('Untappd check-in id'),
      },
    },
    async ({ checkin_id }) => {
      const data = await client.get(`/checkin/view/${checkin_id}`);
      return textResult(data);
    },
  );
}
