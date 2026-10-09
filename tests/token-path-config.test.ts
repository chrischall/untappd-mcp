import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { UntappdClient } from '../src/client.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { createTestHarness } from './helpers.js';

// The password-free UNTAPPD_ACCESS_TOKEN path must be reachable from every
// install surface, not just a hand-written env.
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
  server: { mcp_config: { env: Record<string, string> } };
  user_config: Record<string, { required?: boolean; sensitive?: boolean }>;
};
const registry = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
  packages: { environmentVariables: { name: string; isRequired?: boolean; isSecret?: boolean }[] }[];
};
const plugin = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8')) as {
  mcpServers: Record<string, { env: Record<string, string> }>;
};

describe('access-token install path', () => {
  it('the .mcpb manifest offers an optional, sensitive access token and maps it to UNTAPPD_ACCESS_TOKEN', () => {
    const tok = manifest.user_config.untappd_access_token;
    expect(tok).toBeDefined();
    expect(tok.sensitive).toBe(true);
    expect(tok.required).not.toBe(true);
    expect(manifest.server.mcp_config.env.UNTAPPD_ACCESS_TOKEN).toBe('${user_config.untappd_access_token}');
  });

  it('the .mcpb manifest no longer forces a username/password on a token user', () => {
    expect(manifest.user_config.untappd_password.required).not.toBe(true);
    expect(manifest.user_config.untappd_username.required).not.toBe(true);
  });

  it('the plugin .mcp.json passes UNTAPPD_ACCESS_TOKEN through', () => {
    expect(plugin.mcpServers.untappd.env.UNTAPPD_ACCESS_TOKEN).toBe('${UNTAPPD_ACCESS_TOKEN}');
  });

  it('the MCP registry server.json lists the token and does not require a password', () => {
    const vars = new Map(registry.packages[0].environmentVariables.map((v) => [v.name, v]));
    expect(vars.get('UNTAPPD_ACCESS_TOKEN')).toMatchObject({ isRequired: false, isSecret: true });
    expect(vars.get('UNTAPPD_PASSWORD')?.isRequired).toBe(false);
    expect(vars.get('UNTAPPD_USERNAME')?.isRequired).toBe(false);
  });

  describe('unconfigured healthcheck', () => {
    let harness: Awaited<ReturnType<typeof createTestHarness>>;
    afterAll(async () => {
      if (harness) await harness.close();
    });
    it('names the access-token path as well as username/password', async () => {
      const client = new UntappdClient();
      vi.spyOn(client, 'configured', 'get').mockReturnValue(false);
      harness = await createTestHarness((server) => registerUtilityTools(server, client));
      const r = (await harness.callTool('untappd_healthcheck', {})) as { content: { text: string }[] };
      const out = JSON.parse(r.content[0].text) as { configured: boolean; note: string };
      expect(out.configured).toBe(false);
      expect(out.note).toContain('UNTAPPD_ACCESS_TOKEN');
      expect(out.note).toContain('UNTAPPD_PASSWORD');
    });
  });
});
