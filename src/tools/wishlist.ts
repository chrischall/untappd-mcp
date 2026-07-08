import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import { client } from '../client.js';

const BidSchema = z.number().int().positive().describe('Untappd beer id (bid) — from untappd_search_beer');

export function registerWishlistTools(server: McpServer): void {
  server.registerTool(
    'untappd_wishlist_add',
    {
      title: 'Add a beer to your wishlist',
      description:
        'Add a beer to YOUR Untappd wishlist by its bid. Without confirm: true it returns a dry-run preview and ' +
        'makes NO network call; with confirm: true it adds. Writes to your account.',
      annotations: toolAnnotations({ title: 'Add a beer to your wishlist', readOnly: false, idempotent: true, openWorld: true }),
      inputSchema: {
        bid: BidSchema,
        confirm: schemaConfirm,
      },
    },
    async ({ bid, confirm }) => {
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'wishlist_add',
          bid,
          note: 'Dry run — re-run with confirm: true to add this beer to your wishlist.',
        });
      }
      const data = await client.write<{ result?: string }>('GET', '/user/wishlist/add', { query: { bid } });
      return textResult({ added: true, bid, result: data?.result });
    },
  );

  server.registerTool(
    'untappd_wishlist_remove',
    {
      title: 'Remove a beer from your wishlist',
      description:
        'Remove a beer from YOUR Untappd wishlist by its bid. Without confirm: true it returns a dry-run preview ' +
        'and makes NO network call; with confirm: true it removes. Writes to your account.',
      annotations: toolAnnotations({ title: 'Remove a beer from your wishlist', readOnly: false, idempotent: true, openWorld: true }),
      inputSchema: {
        bid: BidSchema,
        confirm: schemaConfirm,
      },
    },
    async ({ bid, confirm }) => {
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'wishlist_remove',
          bid,
          note: 'Dry run — re-run with confirm: true to remove this beer from your wishlist.',
        });
      }
      const data = await client.write<{ result?: string }>('GET', '/user/wishlist/delete', { query: { bid } });
      return textResult({ removed: true, bid, result: data?.result });
    },
  );
}
