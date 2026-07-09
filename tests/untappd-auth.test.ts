import { describe, it, expect, vi } from 'vitest';
import { untappdAuth } from '../src/untappd-auth.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(responses: Response[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const next = responses.shift();
    if (!next) throw new Error('no more mock responses');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('untappdAuth (Cloudflare connector login)', () => {
  it('declares the Untappd service, its two fields, and a privacy note', () => {
    expect(untappdAuth.service).toBe('Untappd');
    expect(untappdAuth.fields).toEqual([
      { name: 'username', label: 'Untappd username or email' },
      { name: 'password', label: 'Untappd password', type: 'password' },
    ]);
    expect(untappdAuth.privacyNote).toMatch(/password/i);
  });

  it('login() exchanges username/password for an access token via xauth and returns connector props', async () => {
    const { impl, calls } = mockFetch([json({ response: { access_token: 'TOK123' } })]);
    // The connector calls `login` with a real global fetch in production; we
    // can't inject `fetchImpl` through the `ConnectorAuth` interface (it only
    // takes `fields` + `env`), so stub the module-global fetch for this test,
    // exactly as the underlying xauth POST would see it.
    vi.stubGlobal('fetch', impl);
    try {
      const props = await untappdAuth.login(
        { username: 'chris', password: 'pw' },
        { UNTAPPD_CLIENT_ID: 'CID', UNTAPPD_CLIENT_SECRET: 'CSEC' },
      );
      expect(props).toEqual({ token: 'TOK123', username: 'chris' });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].url).toContain('/v4/xauth');
      expect(calls[0].url).toContain('client_id=CID');
      expect(calls[0].url).toContain('client_secret=CSEC');
      expect(calls[0].body).toContain('user_name=chris');
      expect(calls[0].body).toContain('user_password=pw');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('login() rejects on bad credentials (xauth 401)', async () => {
    const { impl } = mockFetch([json({}, 401)]);
    vi.stubGlobal('fetch', impl);
    try {
      await expect(
        untappdAuth.login({ username: 'chris', password: 'wrong' }, { UNTAPPD_CLIENT_ID: 'CID', UNTAPPD_CLIENT_SECRET: 'CSEC' }),
      ).rejects.toThrow(/login failed/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
