import { describe, it, expect } from 'vitest';
import { RateLimitError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../src/client.js';
import { CheckinCache } from '../src/cache/db.js';
import { syncUserBeers } from '../src/cache/sync-beers.js';
import { syncCheckins } from '../src/cache/sync.js';
import type { ApiCallObservation } from '../src/ratelimit.js';

const beerItem = (i: number) => ({
  count: 1,
  recent_created_at: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toUTCString(),
  beer: { bid: 1000 + i, beer_name: `Beer ${i}` },
  brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
});

const checkinItem = (id: number) => ({ checkin_id: id, beer: { bid: id }, created_at: 'Wed, 10 Feb 2016 12:00:00 +0000' });

/**
 * A fake client whose every call is recorded in its rate-limit tracker, seeded
 * with `spent` calls already made this hour. `fail` decides per call (1-based)
 * whether to answer 429.
 */
function fakeClient(opts: {
  spent: number;
  route: (path: string, q: Record<string, unknown>) => unknown;
  fail?: (n: number) => boolean;
}) {
  const now = Date.now();
  const obs: ApiCallObservation[] = Array.from({ length: opts.spent }, (_, i) => ({
    at: now - 30 * 60_000 + i, status: 200, remaining: 0, limit: null, reset_at: null, retry_after_s: null,
  }));
  const paths: string[] = [];
  const client = {
    rateLimit: { observations: () => obs },
    async get(path: string, q: Record<string, unknown> = {}) {
      paths.push(`${path}?${new URLSearchParams(q as Record<string, string>).toString()}`);
      const failing = opts.fail?.(paths.length) ?? false;
      obs.push({ at: Date.now(), status: failing ? 429 : 200, remaining: 0, limit: null, reset_at: null, retry_after_s: failing ? 600 : null });
      if (failing) throw new RateLimitError('Untappd', 600);
      return opts.route(path, q);
    },
  } as unknown as UntappdClient;
  return { client, paths };
}

const beersRoute = (total: number) => (_p: string, q: Record<string, unknown>) => {
  const offset = Number(q.offset ?? 0);
  const items = [];
  for (let k = offset; k < Math.min(total, offset + 50); k++) items.push(beerItem(total - k));
  return { total_count: total, beers: { count: items.length, items } };
};

describe('syncUserBeers stops before the rate limit', () => {
  it('stops cleanly when the guard says the hour is nearly spent, saving progress and resume info', async () => {
    const cache = CheckinCache.open(':memory:');
    // 96 spent: est 4 → page 1 ok (4-1>=2), page 2 ok (3-1>=2), page 3 refused (2-1<2).
    const { client, paths } = fakeClient({ spent: 96, route: beersRoute(500) });
    const s = await syncUserBeers(client, cache, 'mer', 10);
    expect(paths).toHaveLength(2);
    expect(s).toMatchObject({
      pages_fetched: 2,
      cached_distinct_beers: 100,
      another_run_needed: true,
      beers_complete: false,
      stopped_for_rate_limit: true,
    });
    expect(s.rate_limit).toMatchObject({ estimated_remaining: 2, hourly_limit: 100 });
    expect(s.rate_limit?.resume_at).toEqual(expect.any(String));
    expect(s.note).toMatch(/run untappd_sync_user_beers again after/);
    expect((await cache.getState('mer'))?.beers_offset).toBe(100);
    cache.close();
  });

  it('turns a 429 mid-batch into a clean stop instead of throwing', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeClient({ spent: 0, route: beersRoute(500), fail: (n) => n === 3 });
    const s = await syncUserBeers(client, cache, 'mer', 10);
    expect(s).toMatchObject({ pages_fetched: 2, cached_distinct_beers: 100, stopped_for_rate_limit: true, another_run_needed: true });
    expect(s.rate_limit).toMatchObject({ resume_after_s: 600, reason: expect.stringMatching(/429/) });
    expect((await cache.getState('mer'))?.beers_offset).toBe(100);
    cache.close();
  });

  it('a run that is not near the limit reports no stop', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeClient({ spent: 0, route: beersRoute(120) });
    const s = await syncUserBeers(client, cache, 'mer', 10);
    expect(s).toMatchObject({ beers_complete: true, stopped_for_rate_limit: false });
    expect(s.rate_limit).toBeUndefined();
    cache.close();
  });
});

describe('syncCheckins stops before the rate limit', () => {
  const route = (total: number) => (path: string, q: Record<string, unknown>) => {
    if (path.startsWith('/user/info/')) return { user: { stats: { total_checkins: total } } };
    const maxId = q.max_id === undefined ? total + 1 : Number(q.max_id);
    const items = [];
    for (let id = maxId - 1; id >= 1 && items.length < 50; id--) items.push(checkinItem(id));
    const last = items[items.length - 1]?.checkin_id ?? null;
    return { checkins: { items, pagination: { max_id: last && last > 1 ? last : null } } };
  };

  it('makes no call at all when the hour is already spent', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client, paths } = fakeClient({ spent: 99, route: route(500) });
    const s = await syncCheckins(client, cache, 'me', { maxPages: 5 });
    expect(paths).toEqual([]);
    expect(s).toMatchObject({ pages_fetched: 0, stopped_for_rate_limit: true, another_run_needed: true });
    cache.close();
  });

  it('turns a 429 mid-backfill into a clean stop with the cursor saved', async () => {
    const cache = CheckinCache.open(':memory:');
    // call 1 = user/info, 2-3 = pages, 4 = 429
    const { client } = fakeClient({ spent: 0, route: route(500), fail: (n) => n === 4 });
    const s = await syncCheckins(client, cache, 'me', { maxPages: 5 });
    expect(s).toMatchObject({ pages_fetched: 2, cached_checkins: 100, stopped_for_rate_limit: true, another_run_needed: true });
    expect((await cache.getState('me'))?.oldest_max_id).toBe(401);
    // The next run resumes from the saved cursor.
    const again = fakeClient({ spent: 0, route: route(500) });
    await syncCheckins(again.client, cache, 'me', { maxPages: 1 });
    expect(again.paths[1]).toContain('max_id=401');
    cache.close();
  });
});
