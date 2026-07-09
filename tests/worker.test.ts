import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Handshake test for the Untappd Cloudflare remote connector, run inside the
// real Workers runtime (Miniflare) via `@cloudflare/vitest-pool-workers`
// against `wrangler.jsonc`. Hermetic: no real Untappd network calls — the
// `/authorize` GET only renders the login page (no credentials are
// submitted), and the `/mcp` request is expected to be rejected before any
// tool/client code ever runs.
//
// The full authenticated `initialize` + `tools/list` handshake requires a
// real OAuth access token minted via `workers-oauth-provider`'s KV-backed
// grant flow (POST /authorize with real creds → redirect with an auth code →
// POST /token to exchange for an access token), which would mean either a
// real Untappd xauth login or extensive mocking of the provider's internal
// KV records — out of scope for a hermetic in-process test. So this test is
// scoped to the two things that don't require a live user session: the
// unauthenticated-rejection path and the login-page rendering.
describe('Untappd Cloudflare connector — handshake', () => {
  it('rejects an unauthenticated /mcp request', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /authorize renders the Untappd login page with both field labels', async () => {
    // No `client_id` query param: `parseAuthRequest` only looks up (and can
    // throw "Invalid client" for) a client when one is present, and
    // registering a real OAuth client via /register isn't needed to verify
    // the login page itself renders correctly.
    const res = await SELF.fetch('https://example.com/authorize?response_type=code&state=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Untappd');
    expect(html).toContain('Untappd username or email');
    expect(html).toContain('Untappd password');
    expect(html).toContain('type="password"');
  });
});
