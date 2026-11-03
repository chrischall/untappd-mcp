import { describe, it, expect, beforeEach } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import { RESPONSE_CACHE_RETENTION_MS } from '../src/cache/store.js';
import { cachedResponse, VENUE_RESPONSE_TTL_MS } from '../src/cache/response-cache.js';

const T0 = new Date('2026-11-01T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('cachedResponse (venue menu / activity short-TTL cache)', () => {
  let cache: CheckinCache;
  let calls: number;
  const fetch = (v: unknown) => async () => {
    calls++;
    return v;
  };
  beforeEach(() => {
    cache = CheckinCache.open(':memory:');
    calls = 0;
  });

  it('defaults the TTL to 6 hours', () => {
    expect(VENUE_RESPONSE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('a miss fetches and stores; a hit within the TTL makes no call', async () => {
    const a = await cachedResponse(cache, 'venue_menu:1', 'venue_menu', fetch({ beers: [1] }), { now: T0 });
    expect(a).toEqual({ data: { beers: [1] }, hit: false, fetched_at: T0.toISOString(), expires_at: later(VENUE_RESPONSE_TTL_MS).toISOString() });
    const b = await cachedResponse(cache, 'venue_menu:1', 'venue_menu', fetch({ beers: [2] }), { now: later(VENUE_RESPONSE_TTL_MS - 1) });
    expect(b).toMatchObject({ data: { beers: [1] }, hit: true, fetched_at: T0.toISOString() });
    expect(calls).toBe(1);
  });

  it('TTL expiry: an entry 6 hours old is re-fetched and replaced', async () => {
    await cachedResponse(cache, 'k', 'venue_activity', fetch('old'), { now: T0 });
    const r = await cachedResponse(cache, 'k', 'venue_activity', fetch('new'), { now: later(VENUE_RESPONSE_TTL_MS) });
    expect(r).toMatchObject({ data: 'new', hit: false, fetched_at: later(VENUE_RESPONSE_TTL_MS).toISOString() });
    expect(calls).toBe(2);
    expect((await cachedResponse(cache, 'k', 'venue_activity', fetch('x'), { now: later(VENUE_RESPONSE_TTL_MS + 1) })).data).toBe('new');
  });

  it('honours a custom ttlMs and refresh:true', async () => {
    await cachedResponse(cache, 'k', 'venue_menu', fetch(1), { now: T0 });
    expect((await cachedResponse(cache, 'k', 'venue_menu', fetch(2), { now: later(61_000), ttlMs: 60_000 })).hit).toBe(false);
    expect((await cachedResponse(cache, 'k', 'venue_menu', fetch(3), { now: later(62_000), refresh: true })).data).toBe(3);
    expect(calls).toBe(3);
  });

  it('keys are independent', async () => {
    await cachedResponse(cache, 'venue_menu:1', 'venue_menu', fetch('one'), { now: T0 });
    expect((await cachedResponse(cache, 'venue_menu:2', 'venue_menu', fetch('two'), { now: T0 })).data).toBe('two');
    expect(calls).toBe(2);
  });

  it('a failed fetch is not cached', async () => {
    await expect(
      cachedResponse(cache, 'k', 'venue_menu', async () => { throw new Error('429'); }, { now: T0 }),
    ).rejects.toThrow('429');
    expect(await cache.getCachedResponse('k')).toBeUndefined();
  });

  it('prunes entries past the retention window on write', async () => {
    await cachedResponse(cache, 'old', 'venue_activity', fetch(1), { now: T0 });
    await cachedResponse(cache, 'new', 'venue_activity', fetch(2), { now: later(RESPONSE_CACHE_RETENTION_MS + 1) });
    expect(await cache.getCachedResponse('old')).toBeUndefined();
    expect((await cache.stats()).response_cache_entries).toBe(1);
  });

  it('works without a cache (always fetches)', async () => {
    const r = await cachedResponse(undefined, 'k', 'venue_menu', fetch(1), { now: T0 });
    expect(r).toEqual({ data: 1, hit: false, fetched_at: T0.toISOString(), expires_at: null });
  });
});
