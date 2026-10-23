import { describe, it, expect } from 'vitest';
import { UntappdClient } from '../src/client.js';
import { clampToQuota } from '../src/quota.js';

function clientWithHeader(header: string | null) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ meta: { code: 200 }, response: { ok: true } }), {
      status: 200,
      headers: header === null ? {} : { 'X-Ratelimit-Remaining': header },
    })) as unknown as typeof fetch;
  return new UntappdClient({ fetchImpl, token: 't' });
}

describe('X-Ratelimit-Remaining', () => {
  it('is unknown until a response carries it, then tracks the latest value', async () => {
    const c = clientWithHeader('37');
    expect(c.quotaRemaining).toBeNull();
    await c.get('/beer/info/1');
    expect(c.quotaRemaining).toBe(37);
  });

  it('stays unknown when the header is absent or garbage', async () => {
    for (const h of [null, '', 'abc', '-3']) {
      const c = clientWithHeader(h);
      await c.get('/beer/info/1');
      expect(c.quotaRemaining).toBeNull();
    }
  });
});

describe('clampToQuota', () => {
  const fake = (q: number | null | undefined) => ({ quotaRemaining: q }) as unknown as UntappdClient;
  it('keeps the requested budget when the quota is unknown or ample', () => {
    expect(clampToQuota(fake(null), 60)).toEqual({ budget: 60, quota_remaining: null, clamped: false });
    expect(clampToQuota({} as UntappdClient, 60)).toEqual({ budget: 60, quota_remaining: null, clamped: false });
    expect(clampToQuota(fake(80), 60)).toEqual({ budget: 60, quota_remaining: 80, clamped: false });
  });
  it('cuts the budget to what is left, respecting the floor', () => {
    expect(clampToQuota(fake(12), 60)).toEqual({ budget: 12, quota_remaining: 12, clamped: true });
    expect(clampToQuota(fake(0), 60)).toEqual({ budget: 0, quota_remaining: 0, clamped: true });
    expect(clampToQuota(fake(0), 10, 1)).toEqual({ budget: 1, quota_remaining: 0, clamped: true });
  });
});
