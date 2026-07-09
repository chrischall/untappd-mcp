import { describe, it, expect, vi } from 'vitest';
import { UntappdClient, xauthLogin } from '../src/client.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A mock fetch that returns queued responses and records the calls. */
function mockFetch(responses: Response[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('no more mock responses');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

// A fresh xauth response per use — a Response body can only be read once.
const xauth = () => json({ response: { access_token: 'TOK123' } });

describe('UntappdClient', () => {
  it('logs in via xauth on first request, then reads with the token in the query', async () => {
    const { impl, calls } = mockFetch([xauth(), json({ meta: { code: 200 }, response: { user: { uid: 1 } } })]);
    const client = new UntappdClient({ fetchImpl: impl, username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC' });

    const data = await client.get<{ user: { uid: number } }>('/user/info/chris', { compact: 'true' });
    expect(data.user.uid).toBe(1);

    // First call is the xauth login POST carrying client creds + the password form.
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v4/xauth');
    expect(calls[0].url).toContain('client_id=CID');
    expect(calls[0].url).toContain('client_secret=CSEC');
    expect(calls[0].body).toContain('user_name=chris');
    expect(calls[0].body).toContain('user_password=pw');

    // Second call is the read, token in the query (not a Bearer header).
    expect(calls[1].url).toContain('/v4/user/info/chris');
    expect(calls[1].url).toContain('access_token=TOK123');
    expect(calls[1].url).toContain('compact=true');
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  it('writes with an Authorization: Bearer header and client creds in the query', async () => {
    const { impl, calls } = mockFetch([xauth(), json({ meta: { code: 200 }, response: { result: 'success' } })]);
    const client = new UntappdClient({ fetchImpl: impl, username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC' });

    await client.write('POST', '/checkin/toast/42', { form: { note: 'x' } });

    const write = calls[1];
    expect(write.method).toBe('POST');
    expect(write.url).toContain('/v4/checkin/toast/42');
    expect(write.headers.Authorization).toBe('Bearer TOK123');
    expect(write.url).toContain('client_id=CID');
    expect(write.url).not.toContain('access_token=');
    expect(write.body).toContain('note=x');
  });

  it('re-logs in once and retries when a read returns 401', async () => {
    const { impl, calls } = mockFetch([xauth(),
      json({}, 401),
      json({ response: { access_token: 'TOK2' } }),
      json({ meta: { code: 200 }, response: { ok: true } }),
    ]);
    const client = new UntappdClient({ fetchImpl: impl, username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC' });

    await client.get('/checkin/recent', { limit: 1 });

    // login, read(401), login-again, read(200) → 4 calls; final read uses the fresh token.
    expect(calls).toHaveLength(4);
    expect(calls[3].url).toContain('access_token=TOK2');
  });

  it('coalesces concurrent first requests into a single login', async () => {
    const { impl, calls } = mockFetch([xauth(),
      json({ meta: { code: 200 }, response: { a: 1 } }),
      json({ meta: { code: 200 }, response: { b: 2 } }),
    ]);
    const client = new UntappdClient({ fetchImpl: impl, username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC' });

    await Promise.all([client.get('/a'), client.get('/b')]);

    const logins = calls.filter((c) => c.url.includes('/v4/xauth'));
    expect(logins).toHaveLength(1);
  });

  it('surfaces an Untappd error when meta.code >= 400', async () => {
    const { impl } = mockFetch([xauth(), json({ meta: { code: 404, error_detail: 'not found' } })]);
    const client = new UntappdClient({ fetchImpl: impl, username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC' });
    await expect(client.get('/beer/info/999999999')).rejects.toThrow(/404|not found/i);
  });

  it('throws a config error (no network) when credentials are absent', async () => {
    // Explicit undefined ClientOptions fields fall through to `readEnvVar` via
    // `??`, so a real local `.env` would otherwise leak in here — stub the
    // four vars empty (readEnvVar treats '' as unset) to truly simulate "unset".
    vi.stubEnv('UNTAPPD_USERNAME', '');
    vi.stubEnv('UNTAPPD_PASSWORD', '');
    vi.stubEnv('UNTAPPD_CLIENT_ID', '');
    vi.stubEnv('UNTAPPD_CLIENT_SECRET', '');
    try {
      const { impl, calls } = mockFetch([]);
      const client = new UntappdClient({ fetchImpl: impl });
      expect(client.configured).toBe(false);
      await expect(client.get('/user/info/chris')).rejects.toThrow(/credentials/i);
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('builds a working write-path client from token + app creds, no password', async () => {
    const { impl, calls } = mockFetch([json({ meta: { code: 200 }, response: { result: 'success' } })]);
    const client = new UntappdClient({ fetchImpl: impl, token: 'TOK', clientId: 'CID', clientSecret: 'CSEC', loginName: 'chris' });
    await client.write('POST', '/checkin/toast/42');
    expect(calls).toHaveLength(1);          // NO login call — token was pre-seeded
    expect(calls[0].headers.Authorization).toBe('Bearer TOK');
    expect(calls[0].url).toContain('client_id=CID');
    expect(client.loginName).toBe('chris');
    expect(client.configured).toBe(true);
  });

  it('a token-seeded read sends the token in the query and never logs in', async () => {
    const { impl, calls } = mockFetch([json({ meta: { code: 200 }, response: { user: { uid: 1 } } })]);
    const client = new UntappdClient({ fetchImpl: impl, token: 'TOK', clientId: 'CID', clientSecret: 'CSEC' });
    await client.get('/user/info/chris');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('access_token=TOK');
  });
});

describe('xauthLogin (standalone helper used by the Cloudflare connector login)', () => {
  it('performs the xauth POST and returns the access token', async () => {
    const { impl, calls } = mockFetch([xauth()]);
    const token = await xauthLogin(
      { username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC' },
      { fetchImpl: impl },
    );
    expect(token).toBe('TOK123');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v4/xauth');
    expect(calls[0].url).toContain('client_id=CID');
    expect(calls[0].url).toContain('client_secret=CSEC');
    expect(calls[0].body).toContain('user_name=chris');
    expect(calls[0].body).toContain('user_password=pw');
  });

  it('throws a helpful error on bad credentials (401)', async () => {
    const { impl } = mockFetch([json({}, 401)]);
    await expect(
      xauthLogin({ username: 'chris', password: 'wrong', clientId: 'CID', clientSecret: 'CSEC' }, { fetchImpl: impl }),
    ).rejects.toThrow(/login failed/i);
  });
});
