import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, createHelpfulError } from '@chrischall/mcp-utils';
import { client } from '../client.js';
import { compactCheckins, compactWishlist, compactUserBeers } from '../compact.js';

const UsernameArg = z
  .string()
  .min(1)
  .optional()
  .describe('Untappd username. Omit to use your own configured account (UNTAPPD_USERNAME).');

/** Resolve the target username: explicit arg, else the configured login name. */
function resolveUser(username: string | undefined): string {
  const u = username ?? client.loginName;
  if (!u) {
    throw createHelpfulError('No username given and no configured account to fall back to.', {
      hint: 'Pass `username`, or set UNTAPPD_USERNAME so user tools default to your own account.',
    });
  }
  return encodeURIComponent(u);
}

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'untappd_user_info',
    {
      title: 'Get Untappd user profile',
      description:
        "Get an Untappd user's profile: bio, location, total check-ins, distinct beers, badges, and stats. " +
        'Omit username for your own account. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd user profile', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        compact: z.boolean().optional().describe('Return a slimmer record without embedded lists (default false)'),
      },
    },
    async ({ username, compact }) => {
      const data = await client.get(`/user/info/${resolveUser(username)}`, { compact: compact ? 'true' : undefined });
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_user_checkins',
    {
      title: 'Get Untappd user check-ins',
      description:
        "Get a user's recent check-ins (most recent first): the beer, rating, comment, venue, and toasts/comments. " +
        'Page backwards with max_id (the pagination.max_id from a prior call). Omit username for your own. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd user check-ins', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        compact: z
          .boolean()
          .optional()
          .describe('Project each check-in to a slim summary to save context (default false)'),
      },
    },
    async ({ username, limit, max_id, compact }) => {
      const data = await client.get(`/user/checkins/${resolveUser(username)}`, { limit, max_id });
      return textResult(compact ? compactCheckins(data) : data);
    },
  );

  server.registerTool(
    'untappd_user_wishlist',
    {
      title: 'Get Untappd user wishlist',
      description:
        "Get the beers on a user's wishlist. Supports sorting and paging. Omit username for your own account. Read-only.",
      annotations: toolAnnotations({ title: 'Get Untappd user wishlist', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        limit: z.number().int().min(1).max(50).optional().describe('Max beers (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
        sort: z
          .enum(['date', 'name', 'brewery', 'style', 'rating', 'abv'])
          .optional()
          .describe('Sort order (default date added, newest first)'),
        compact: z
          .boolean()
          .optional()
          .describe('Project each beer to a slim summary (bid, name, brewery, style, abv, added_at) to save context (default false)'),
      },
    },
    async ({ username, limit, offset, sort, compact }) => {
      const data = await client.get(`/user/wishlist/${resolveUser(username)}`, { limit, offset, sort });
      return textResult(compact ? compactWishlist(data) : data);
    },
  );

  server.registerTool(
    'untappd_user_beers',
    {
      title: 'Get Untappd distinct beers',
      description:
        "Get the distinct (unique) beers a user has ever checked in, with their rating and check-in count per beer. " +
        'Supports sorting and paging. Omit username for your own account. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd distinct beers', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        limit: z.number().int().min(1).max(50).optional().describe('Max beers (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
        sort: z
          .enum(['date', 'checkin', 'highest_rated', 'lowest_rated', 'name', 'this_month', 'highest_abv'])
          .optional()
          .describe('Sort order (default date, most recent first)'),
        compact: z
          .boolean()
          .optional()
          .describe('Project each beer to a slim summary (bid, name, brewery, style, abv, ibu, your_count, your_rating, global_rating, last_had) to save context (default false)'),
      },
    },
    async ({ username, limit, offset, sort, compact }) => {
      const data = await client.get(`/user/beers/${resolveUser(username)}`, { limit, offset, sort });
      return textResult(compact ? compactUserBeers(data) : data);
    },
  );

  server.registerTool(
    'untappd_user_badges',
    {
      title: 'Get Untappd user badges',
      description: "Get the badges a user has earned, most recent first. Omit username for your own account. Read-only.",
      annotations: toolAnnotations({ title: 'Get Untappd user badges', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        limit: z.number().int().min(1).max(50).optional().describe('Max badges (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ username, limit, offset }) => {
      const data = await client.get(`/user/badges/${resolveUser(username)}`, { limit, offset });
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_user_friends',
    {
      title: 'Get Untappd user friends',
      description: "Get a user's friend list. Omit username for your own account. Read-only.",
      annotations: toolAnnotations({ title: 'Get Untappd user friends', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        limit: z.number().int().min(1).max(50).optional().describe('Max friends (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ username, limit, offset }) => {
      const data = await client.get(`/user/friends/${resolveUser(username)}`, { limit, offset });
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_user_venues',
    {
      title: 'Get venues a user has checked in at',
      description:
        "Get the venues a user has checked in at, most recent first, with per-venue check-in counts. Supports " +
        'sorting and paging. Omit username for your own account. Read-only.',
      annotations: toolAnnotations({ title: 'Get venues a user has checked in at', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        username: UsernameArg,
        limit: z.number().int().min(1).max(50).optional().describe('Max venues (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
        sort: z
          .enum(['date', 'name', 'checkin', 'highest_rated'])
          .optional()
          .describe('Sort order (default most recent)'),
      },
    },
    async ({ username, limit, offset, sort }) => {
      const data = await client.get(`/user/venues/${resolveUser(username)}`, { limit, offset, sort });
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_pending_friends',
    {
      title: 'Get your pending friend requests',
      description:
        'Get the incoming friend requests waiting on YOUR account — the users who have requested to be your ' +
        'friend. Read-only.',
      annotations: toolAnnotations({ title: 'Get your pending friend requests', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max requests (1–50, default 25)'),
        offset: z.number().int().min(0).optional().describe('Result offset for paging (default 0)'),
      },
    },
    async ({ limit, offset }) => {
      const data = await client.get('/user/pending', { limit, offset });
      return textResult(data);
    },
  );
}
