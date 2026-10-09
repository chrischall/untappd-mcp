import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UntappdClient } from '../src/client.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { createTestHarness } from './helpers.js';

// What each credential actually unlocks (src/client.ts `request()`):
// - reads carry the token as `access_token` and need NOTHING else;
// - writes add `client_id` / `client_secret`, so they need the app creds;
// - minting a token (xauth) needs username + password + both app creds.
// So a token alone is a working, read-only configuration, and app creds
// alone can make no call at all. `configured`, the missing-credential error
// and the healthcheck must all tell that same story.

const VARS = ['UNTAPPD_ACCESS_TOKEN', 'UNTAPPD_USERNAME', 'UNTAPPD_PASSWORD', 'UNTAPPD_CLIENT_ID', 'UNTAPPD_CLIENT_SECRET'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(responses: Response[]) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('no more mock responses');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const feed = () => json({ meta: { code: 200 }, response: { checkins: { count: 0, items: [] } } });

async function healthcheck(client: UntappdClient) {
  const harness = await createTestHarness((server) => registerUtilityTools(server, client));
  try {
    const r = (await harness.callTool('untappd_healthcheck', {})) as { content: { text: string }[] };
    return JSON.parse(r.content[0].text) as { ok: boolean; configured: boolean; writes_enabled?: boolean; note: string };
  } finally {
    await harness.close();
  }
}

describe('credential matrix: configured / errors / healthcheck agree with what can be called', () => {
  // Stub every credential empty (readEnvVar treats '' as unset) so a local .env cannot leak in.
  beforeEach(() => {
    for (const k of VARS) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('token only', () => {
    it('is configured, reads without app creds, and reports writes as unavailable', async () => {
      const { impl, urls } = mockFetch([feed(), feed()]);
      const client = new UntappdClient({ fetchImpl: impl, token: 'TOK' });
      expect(client.configured).toBe(true);
      expect(client.canWrite).toBe(false);

      await client.get('/checkin/recent', { limit: 1 });
      expect(urls[0]).toContain('access_token=TOK');
      expect(urls[0]).not.toContain('client_id');

      const out = await healthcheck(client);
      expect(out.ok).toBe(true);
      expect(out.configured).toBe(true);
      expect(out.writes_enabled).toBe(false);
      expect(out.note).toMatch(/UNTAPPD_CLIENT_ID/);
    });

    it('a write fails naming only the app creds, without calling the setup unconfigured', async () => {
      const { impl, urls } = mockFetch([]);
      const client = new UntappdClient({ fetchImpl: impl, token: 'TOK' });
      const err = String(await client.write('POST', '/checkin/toast/1').catch((e: Error) => e));
      expect(err).toMatch(/UNTAPPD_CLIENT_ID/);
      expect(err).toMatch(/UNTAPPD_CLIENT_SECRET/);
      expect(err).not.toMatch(/UNTAPPD_PASSWORD/);
      expect(err).not.toMatch(/are not configured/i);
      expect(urls).toHaveLength(0);
    });
  });

  describe('client id and secret only', () => {
    it('is not configured, and the error says a token or a login is what is missing', async () => {
      const { impl, urls } = mockFetch([]);
      const client = new UntappdClient({ fetchImpl: impl, clientId: 'CID', clientSecret: 'CSEC' });
      expect(client.configured).toBe(false);
      expect(client.canWrite).toBe(false);

      const err = String(await client.get('/user/info/chris').catch((e: Error) => e));
      expect(err).toMatch(/UNTAPPD_ACCESS_TOKEN/);
      expect(err).toMatch(/missing UNTAPPD_USERNAME, UNTAPPD_PASSWORD\b/);
      expect(err).not.toMatch(/missing[^.]*UNTAPPD_CLIENT_ID/);
      expect(urls).toHaveLength(0);

      const out = await healthcheck(client);
      expect(out.configured).toBe(false);
      expect(out.note).toContain('UNTAPPD_ACCESS_TOKEN');
    });
  });

  describe('token and client id/secret', () => {
    it('is configured for reads and writes', async () => {
      const { impl } = mockFetch([feed()]);
      const client = new UntappdClient({ fetchImpl: impl, token: 'TOK', clientId: 'CID', clientSecret: 'CSEC' });
      expect(client.configured).toBe(true);
      expect(client.canWrite).toBe(true);

      const out = await healthcheck(client);
      expect(out.ok).toBe(true);
      expect(out.writes_enabled).toBe(true);
    });
  });

  describe('neither', () => {
    it('is not configured, and the error names the token path and the full login set', async () => {
      const { impl, urls } = mockFetch([]);
      const client = new UntappdClient({ fetchImpl: impl });
      expect(client.configured).toBe(false);
      expect(client.canWrite).toBe(false);

      const err = String(await client.get('/user/info/chris').catch((e: Error) => e));
      expect(err).toMatch(/UNTAPPD_ACCESS_TOKEN/);
      expect(err).toMatch(/UNTAPPD_USERNAME, UNTAPPD_PASSWORD, UNTAPPD_CLIENT_ID, UNTAPPD_CLIENT_SECRET/);
      // Must not claim the app creds are needed for every path any more.
      expect(err).not.toMatch(/Either way/);
      expect(urls).toHaveLength(0);

      const out = await healthcheck(client);
      expect(out.configured).toBe(false);
      expect(out.note).not.toMatch(/Configure UNTAPPD_CLIENT_ID and UNTAPPD_CLIENT_SECRET, plus/);
    });
  });
});
