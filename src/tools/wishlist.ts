import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { confirmTokenParam, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { CONFIRM_FLOW, confirmWrite } from './confirm.js';

const BidSchema = z.number().int().positive().describe('Untappd beer id (bid) — from untappd_search_beer');

export function registerWishlistTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_wishlist_add',
    {
      title: 'Add a beer to your wishlist',
      description: `Add a beer to YOUR Untappd wishlist by its bid. Writes to your account. ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: 'Add a beer to your wishlist', readOnly: false, idempotent: true, openWorld: true, destructive: false }),
      inputSchema: z.object({
        bid: BidSchema,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ bid, confirmToken }, ctx) => {
      const request = { method: 'GET', path: '/user/wishlist/add', query: { bid } };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_wishlist_add',
        action: 'untappd.wishlist_add',
        message: 'Review and confirm adding this beer to your Untappd wishlist:',
        confirmToken,
        target: bid,
        payload: request,
        preview: { action: 'wishlist_add', bid, ...request, note: 'Adds this beer to your Untappd wishlist.' },
      });
      if (gate) return gate;
      const data = await client.write<{ result?: string }>('GET', '/user/wishlist/add', { query: { bid } });
      return minifiedResult({ added: true, bid, result: data?.result });
    },
  );

  server.registerTool(
    'untappd_wishlist_remove',
    {
      title: 'Remove a beer from your wishlist',
      description: `Remove a beer from YOUR Untappd wishlist by its bid. Writes to your account. ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: 'Remove a beer from your wishlist', readOnly: false, idempotent: true, openWorld: true, destructive: false }),
      inputSchema: z.object({
        bid: BidSchema,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ bid, confirmToken }, ctx) => {
      const request = { method: 'GET', path: '/user/wishlist/delete', query: { bid } };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_wishlist_remove',
        action: 'untappd.wishlist_remove',
        message: 'Review and confirm removing this beer from your Untappd wishlist:',
        confirmToken,
        target: bid,
        payload: request,
        preview: { action: 'wishlist_remove', bid, ...request, note: 'Removes this beer from your Untappd wishlist.' },
      });
      if (gate) return gate;
      const data = await client.write<{ result?: string }>('GET', '/user/wishlist/delete', { query: { bid } });
      return minifiedResult({ removed: true, bid, result: data?.result });
    },
  );
}
