import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';

export function registerUtilityTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_healthcheck',
    {
      title: 'Untappd healthcheck',
      description:
        'Verify Untappd connectivity and that credentials are configured and can log in. Performs a lightweight ' +
        'authenticated request (your recent feed) and reports whether it succeeded. Read-only.',
      annotations: toolAnnotations({ title: 'Untappd healthcheck', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {},
    },
    async () => {
      if (!client.configured) {
        return textResult({
          ok: false,
          configured: false,
          note: 'Untappd credentials are not set. Configure UNTAPPD_USERNAME, UNTAPPD_PASSWORD, UNTAPPD_CLIENT_ID, and UNTAPPD_CLIENT_SECRET.',
        });
      }
      const feed = await client.get<{ checkins?: { count?: number } }>('/checkin/recent', { limit: 1 });
      return textResult({
        ok: true,
        configured: true,
        account: client.loginName,
        feed_reachable: feed?.checkins !== undefined,
        note: 'Logged in to Untappd and fetched the friend feed successfully.',
      });
    },
  );
}
