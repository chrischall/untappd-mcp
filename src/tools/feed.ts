import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, resolveView, toolAnnotations, viewResult } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactCheckins, UNTAPPD_VIEWS } from '../compact.js';
import { briefCheckins, foodMeta } from './hints.js';

/**
 * The feed's `view`: the fleet's compact/full rungs plus `brief`, the one-line-per-item
 * answer a context-group host reads aloud (the feed is this server's canonical whats-new).
 */
const FEED_VIEW = z
  .enum(['compact', 'full', 'brief'])
  .optional()
  .describe(
    'Response shape: "compact" (default) projects each check-in to {id, user, beer, brewery, venue, rating, comment, ' +
      'toast/comment counts}; "full" returns Untappd\'s whole ~5 KB record; "brief" returns one line per check-in: ' +
      '<user>: <beer> (<brewery>) at <venue> — <ISO date or "no date"> — <rated N|not rated>, inside the untrusted-data ' +
        'envelope as data: string[], with "-- " note lines ("-- none", "-- more").',
  );

export function registerFeedTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_activity_feed',
    {
      title: 'Get Untappd friend activity feed',
      description:
        'Get your Untappd friend activity feed — the recent check-ins from people you follow, newest first. Page ' +
        'backwards with max_id (the pagination.max_id from a prior call). Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd friend activity feed', readOnly: true, idempotent: false, openWorld: true }),
      _meta: foodMeta('whats-new', { canonical: true, aliases: ['beer', 'check-ins', 'friends drinking', 'what are my friends drinking', 'craft beer'] }),
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        view: FEED_VIEW,
      }),
    },
    async ({ limit, max_id, view }) => {
      const data = await client.get('/checkin/recent', { limit, max_id });
      if (view === 'brief') return { content: [{ type: 'text' as const, text: briefCheckins(data) }] };
      const v = resolveView(view, UNTAPPD_VIEWS);
      return viewResult(v, v === 'compact' ? compactCheckins(data) : data);
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
      _meta: foodMeta('lookup'),
      inputSchema: z.object({
        checkin_id: z.number().int().positive().describe('Untappd check-in id'),
      }),
    },
    async ({ checkin_id }) => {
      const data = await client.get(`/checkin/view/${checkin_id}`);
      return minifiedResult(data);
    },
  );
}
