import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { VERSION } from '../version.js';
import { toolInventory } from './diagnostics.js';

export function registerUtilityTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_healthcheck',
    {
      title: 'Untappd healthcheck',
      description:
        'Verify Untappd connectivity and that credentials are configured and can log in. Performs a lightweight ' +
        'authenticated request (your recent feed) and reports whether it succeeded, plus the running server version ' +
        'and the exact set of tools this build exposes (count, a stable hash, and their names) so you can confirm ' +
        'which build is live. Read-only.',
      annotations: toolAnnotations({ title: 'Untappd healthcheck', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      // Always report build/tool diagnostics, even when credentials are absent,
      // so the live build and its toolset can be confirmed from the client.
      const build = { server_version: VERSION, ...toolInventory(server) };
      if (!client.configured) {
        return textResult({
          ok: false,
          configured: false,
          ...build,
          note: 'Untappd credentials are not set. Configure UNTAPPD_USERNAME, UNTAPPD_PASSWORD, UNTAPPD_CLIENT_ID, and UNTAPPD_CLIENT_SECRET.',
        });
      }
      const feed = await client.get<{ checkins?: { count?: number } }>('/checkin/recent', { limit: 1 });
      return textResult({
        ok: true,
        configured: true,
        account: client.loginName,
        feed_reachable: feed?.checkins !== undefined,
        ...build,
        note: 'Logged in to Untappd and fetched the friend feed successfully.',
      });
    },
  );
}
