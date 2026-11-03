import { describe, it, expect, afterEach } from 'vitest';
import { RateLimitError } from '@chrischall/mcp-utils';
import { UntappdClient } from '../src/client.js';
import { CheckinCache } from '../src/cache/db.js';
import {
  RATE_WINDOW_MS,
  DEFAULT_HOURLY_LIMIT,
  RateLimitTracker,
  checkRateBudget,
  computeRateLimitStatus,
  observeResponse,
  rateLimitStatus,
  stopFrom429,
  type ApiCallObservation,
} from '../src/ratelimit.js';

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const ok = (at: number, extra: Partial<ApiCallObservation> = {}): ApiCallObservation => ({
  at, status: 200, remaining: null, limit: null, reset_at: null, retry_after_s: null, ...extra,
});
const calls = (n: number, start = T0, step = 1000, extra: Partial<ApiCallObservation> = {}) =>
  Array.from({ length: n }, (_, i) => ok(start + i * step, extra));

describe('observeResponse', () => {
  it('reads remaining, limit, reset (epoch seconds) and retry-after', () => {
    const h = new Headers({
      'X-Ratelimit-Remaining': '37',
      'X-Ratelimit-Limit': '100',
      'X-Ratelimit-Reset': String(Math.floor(T0 / 1000) + 600),
      'Retry-After': '30',
    });
    expect(observeResponse(429, h, T0)).toEqual({
      at: T0, status: 429, remaining: 37, limit: 100, reset_at: T0 + 600_000, retry_after_s: 30,
    });
  });

  it('treats a small reset value as seconds-from-now, and ignores garbage', () => {
    expect(observeResponse(200, new Headers({ 'X-Ratelimit-Reset': '120' }), T0).reset_at).toBe(T0 + 120_000);
    const o = observeResponse(200, new Headers({ 'X-Ratelimit-Remaining': 'abc', 'X-Ratelimit-Limit': '0' }), T0);
    expect(o).toMatchObject({ remaining: null, limit: null, reset_at: null, retry_after_s: null });
  });
});

describe('computeRateLimitStatus', () => {
  it('counts calls in the rolling hour against the assumed 100/hour', () => {
    const obs = [ok(T0 - RATE_WINDOW_MS - 1), ...calls(40)];
    const s = computeRateLimitStatus(obs, T0 + 60_000, {});
    expect(s).toMatchObject({
      hourly_limit: DEFAULT_HOURLY_LIMIT, limit_source: 'assumed', calls_last_hour: 40, estimated_remaining: 60,
    });
  });

  it('does NOT trust X-Ratelimit-Remaining: 0 on successful responses (v4 sends 0 on every 200)', () => {
    const s = computeRateLimitStatus(calls(5, T0, 1000, { remaining: 0 }), T0 + 10_000, {});
    expect(s.header_remaining).toBe(0);
    expect(s.header_remaining_trusted).toBe(false);
    expect(s.estimated_remaining).toBe(95);
  });

  it('trusts the header once it has reported a live (non-zero) value, and takes the lower estimate', () => {
    const obs = [ok(T0, { remaining: 12 }), ok(T0 + 1000, { remaining: 11 })];
    const s = computeRateLimitStatus(obs, T0 + 2000, {});
    expect(s.header_remaining_trusted).toBe(true);
    expect(s.estimated_remaining).toBe(11);
  });

  it('prefers a configured limit, then the header limit', () => {
    expect(computeRateLimitStatus([ok(T0, { limit: 150 })], T0, {}).hourly_limit).toBe(150);
    const s = computeRateLimitStatus([ok(T0, { limit: 150 })], T0, { configuredLimit: 1000 });
    expect(s).toMatchObject({ hourly_limit: 1000, limit_source: 'env' });
  });

  it('a 429 blocks until its Retry-After', () => {
    const obs = [...calls(3), ok(T0 + 5000, { status: 429, retry_after_s: 120 })];
    const s = computeRateLimitStatus(obs, T0 + 10_000, {});
    expect(s.estimated_remaining).toBe(0);
    expect(s.blocked_until).toBe(new Date(T0 + 5000 + 120_000).toISOString());
    expect(s.last_429_at).toBe(new Date(T0 + 5000).toISOString());
    // After the wait it is no longer blocked.
    expect(computeRateLimitStatus(obs, T0 + 5000 + 121_000, {}).blocked_until).toBeNull();
  });
});

describe('RateLimitTracker / client', () => {
  it('records every response and prunes past the window', () => {
    const t = new RateLimitTracker();
    t.record(ok(T0 - RATE_WINDOW_MS - 10));
    t.record(ok(T0));
    expect(t.observations(T0)).toHaveLength(1);
  });

  it('the client records each response and quotaRemaining ignores the meaningless 0', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ meta: { code: 200 }, response: {} }), {
        status: 200,
        headers: { 'X-Ratelimit-Remaining': '0' },
      })) as unknown as typeof fetch;
    const seen: ApiCallObservation[] = [];
    const c = new UntappdClient({ fetchImpl, token: 't' });
    c.onApiCall((o) => seen.push(o));
    await c.get('/beer/info/1');
    await c.get('/beer/info/2');
    expect(c.rateLimit.observations()).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(c.quotaRemaining).toBe(DEFAULT_HOURLY_LIMIT - 2);
  });

  it('records a 429 before throwing it', async () => {
    const fetchImpl = (async () =>
      new Response('{}', { status: 429, headers: { 'Retry-After': '60' } })) as unknown as typeof fetch;
    const c = new UntappdClient({ fetchImpl, token: 't' });
    await expect(c.get('/x')).rejects.toBeInstanceOf(RateLimitError);
    expect(c.rateLimit.observations()[0]).toMatchObject({ status: 429, retry_after_s: 60 });
    expect(c.quotaRemaining).toBe(0);
  });
});

describe('checkRateBudget (the stop-before-429 guard)', () => {
  const saved = process.env.UNTAPPD_RATE_LIMIT_PER_HOUR;
  afterEach(() => {
    if (saved === undefined) delete process.env.UNTAPPD_RATE_LIMIT_PER_HOUR;
    else process.env.UNTAPPD_RATE_LIMIT_PER_HOUR = saved;
  });

  const fakeClient = (obs: ApiCallObservation[]) =>
    ({ rateLimit: { observations: () => obs } }) as unknown as UntappdClient;

  it('allows a call while the estimate stays above the reserve', async () => {
    const v = await checkRateBudget(fakeClient(calls(50, Date.now() - 60_000)), undefined);
    expect(v).toMatchObject({ ok: true, calls_last_hour: 50, estimated_remaining: 50 });
  });

  it('refuses once only the reserve is left, with the time the oldest call ages out', async () => {
    const start = Date.now() - 30 * 60_000;
    const v = await checkRateBudget(fakeClient(calls(98, start)), undefined, { reserve: 2 });
    expect(v.ok).toBe(false);
    expect(v.estimated_remaining).toBe(2);
    // One call must age out to afford needed(1) + reserve(2) out of 2 left.
    expect(v.resume_at).toBe(new Date(start + RATE_WINDOW_MS).toISOString());
    expect(v.resume_after_s).toBeGreaterThan(29 * 60);
    expect(v.reason).toMatch(/rate limit/i);
  });

  it('honours UNTAPPD_RATE_LIMIT_PER_HOUR', async () => {
    process.env.UNTAPPD_RATE_LIMIT_PER_HOUR = '1000';
    const v = await checkRateBudget(fakeClient(calls(98, Date.now() - 60_000)), undefined);
    expect(v).toMatchObject({ ok: true, hourly_limit: 1000 });
  });

  it('tolerates a client without a tracker (test fakes) as unconstrained', async () => {
    const v = await checkRateBudget({} as UntappdClient, undefined);
    expect(v.ok).toBe(true);
  });

  it('counts calls other processes logged in the shared cache, without double counting its own', async () => {
    const cache = CheckinCache.open(':memory:');
    const now = Date.now();
    const mine = calls(10, now - 60_000);
    const theirs = calls(85, now - 120_000, 500).map((o) => ({ ...o, at: o.at + 1 }));
    await cache.recordApiCalls([...mine, ...theirs]);
    const v = await checkRateBudget(fakeClient(mine), cache);
    expect(v.calls_last_hour).toBe(95);
    expect(v.ok).toBe(true);
    const status = await rateLimitStatus(fakeClient(mine), cache);
    expect(status.calls_last_hour).toBe(95);
    await cache.recordApiCalls(calls(3, now - 1000, 10));
    expect((await checkRateBudget(fakeClient(mine), cache)).ok).toBe(false);
    cache.close();
  });
});

describe('merging the in-process and shared logs', () => {
  it('keeps two genuine calls in the same millisecond as two', async () => {
    const at = Date.now() - 1000;
    const client = { rateLimit: { observations: () => [ok(at), ok(at)] } } as unknown as UntappdClient;
    expect((await checkRateBudget(client, undefined)).calls_last_hour).toBe(2);
    const cache = CheckinCache.open(':memory:');
    await cache.recordApiCalls([ok(at), ok(at), ok(at + 1)]);
    expect((await checkRateBudget(client, cache)).calls_last_hour).toBe(3);
    cache.close();
  });
});

describe('stopFrom429', () => {
  it('turns a RateLimitError into resume info', () => {
    const s = stopFrom429(new RateLimitError('Untappd', 90), T0);
    expect(s).toMatchObject({ reason: expect.stringMatching(/429/), resume_after_s: 90, resume_at: new Date(T0 + 90_000).toISOString() });
  });
});

describe('untappd_cache_status rate_limit block', () => {
  it('reports the call count, estimate and raw header state from this process and the shared log', async () => {
    const { createTestHarness } = await import('./helpers.js');
    const { registerCacheTools } = await import('../src/tools/cache.js');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ meta: { code: 200 }, response: {} }), {
        status: 200,
        headers: { 'X-Ratelimit-Remaining': '0' },
      })) as unknown as typeof fetch;
    const client = new UntappdClient({ fetchImpl, token: 't' });
    await client.get('/beer/info/1');
    const cache = CheckinCache.open(':memory:');
    // Another process's calls, logged in the shared file.
    await cache.recordApiCalls(calls(4, Date.now() - 5 * 60_000));
    const harness = await createTestHarness((s) => registerCacheTools(s, client, () => cache));
    try {
      const r = await harness.callTool('untappd_cache_status', {});
      const out = JSON.parse((r as { content: { text: string }[] }).content[0].text);
      expect(out.rate_limit).toMatchObject({
        hourly_limit: 100,
        limit_source: 'assumed',
        calls_last_hour: 5,
        estimated_remaining: 95,
        header_remaining: 0,
        header_remaining_trusted: false,
        blocked_until: null,
      });
    } finally {
      await harness.close();
      cache.close();
    }
  });
});
