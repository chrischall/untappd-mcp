import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimitError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../src/client.js';
import { CheckinCache } from '../src/cache/db.js';
import { mapBreweryLikeItem } from '../src/cache/store.js';
import { syncBreweryLikes, BREWERY_LIKES_LIST } from '../src/cache/sync-brewery-likes.js';
import type { ApiCallObservation } from '../src/ratelimit.js';

// One user/brewerylikes item, shaped like the live v4 response (6a report, call #15).
function likeItem(id: number) {
  return {
    created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    relationship: 'none',
    user_id: 42,
    brewery: {
      brewery_id: id,
      brewery_name: `Brewery ${id}`,
      brewery_slug: `brewery-${id}`,
      brewery_page_url: `/w/brewery-${id}/${id}`,
      brewery_type: 'Micro Brewery',
      brewery_label: 'https://example.invalid/label.jpeg',
      country_name: 'United States',
      contact: { url: '' },
      location: { brewery_city: 'Tampa', brewery_state: 'FL', lat: 27.96, lng: -82.42 },
      brewery_active: 1,
    },
  };
}

/**
 * A brewerylikes route: serves up to `serve` per page (the live route honours
 * limit=50), next offset in pagination.offset — ABSENT when the list is empty.
 */
function fakeClient(opts: { getIds: () => number[]; serve?: number; spent?: number; fail?: (n: number) => boolean }) {
  const now = Date.now();
  const obs: ApiCallObservation[] = Array.from({ length: opts.spent ?? 0 }, (_, i) => ({
    at: now - 30 * 60_000 + i, status: 200, remaining: 0, limit: null, reset_at: null, retry_after_s: null,
  }));
  const calls: Array<{ path: string; q: Record<string, unknown> }> = [];
  const client = {
    rateLimit: { observations: () => obs },
    async get(path: string, q: Record<string, unknown> = {}) {
      calls.push({ path, q });
      const failing = opts.fail?.(calls.length) ?? false;
      obs.push({ at: Date.now(), status: failing ? 429 : 200, remaining: 0, limit: null, reset_at: null, retry_after_s: failing ? 600 : null });
      if (failing) throw new RateLimitError('Untappd', 600);
      const ids = opts.getIds();
      const offset = Number(q.offset ?? 0);
      const per = Math.min(Number(q.limit ?? 25), opts.serve ?? 50);
      const page = ids.slice(offset, offset + per);
      if (ids.length === 0) {
        return { total_count: 0, count: 0, items: [], pagination: { next_url: '', max_id: false } };
      }
      return {
        total_count: ids.length,
        count: page.length,
        items: page.map(likeItem),
        pagination: { next_url: 'x', offset: offset + page.length, max_id: false },
      };
    },
  } as unknown as UntappdClient;
  return { client, calls };
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe('mapBreweryLikeItem', () => {
  it('maps the brewery, its location and the like date', () => {
    expect(mapBreweryLikeItem(likeItem(7))).toEqual({
      brewery_id: 7,
      brewery_name: 'Brewery 7',
      brewery_type: 'Micro Brewery',
      country: 'United States',
      city: 'Tampa',
      state: 'FL',
      lat: 27.96,
      lng: -82.42,
      liked_at: '2025-07-05T18:23:11.000Z',
    });
    expect(mapBreweryLikeItem({ brewery: {} })).toBeNull();
    expect(mapBreweryLikeItem(null)).toBeNull();
  });
});

describe('syncBreweryLikes', () => {
  let cache: CheckinCache;
  beforeEach(() => {
    cache = CheckinCache.open(':memory:');
  });

  it('mirrors the whole list at 50 per page, advancing by the returned offset', async () => {
    const { client, calls } = fakeClient({ getIds: () => range(1, 120) });
    const s = await syncBreweryLikes(client, cache, 'Mer', 10);
    expect(calls.map((c) => c.q.offset)).toEqual([0, 50, 100]);
    expect(calls[0]).toMatchObject({ path: '/user/brewerylikes/Mer', q: { limit: 50 } });
    expect(s).toMatchObject({
      likes_added: 120, likes_removed: 0, cached: 120, total: 120, percent: 100,
      complete: true, another_run_needed: false, pages_fetched: 3, stopped_for_rate_limit: false,
    });
    expect((await cache.getBreweryLikes('mer')).length).toBe(120);
    expect((await cache.getBreweryLikes('mer', [5, 999])).map((r) => r.brewery_id)).toEqual([5]);
  });

  it('advances by the RETURNED offset when the server serves fewer than asked (never treats a 25-item page as the end)', async () => {
    const { client, calls } = fakeClient({ getIds: () => range(1, 60), serve: 25 });
    const s = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(calls.map((c) => c.q.offset)).toEqual([0, 25, 50]);
    expect(s).toMatchObject({ complete: true, cached: 60, total: 60 });
  });

  it('an empty list (no pagination.offset) completes in one call', async () => {
    const { client, calls } = fakeClient({ getIds: () => [] });
    const s = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(calls).toHaveLength(1);
    expect(s).toMatchObject({ complete: true, cached: 0, total: 0, another_run_needed: false, next_offset: null, percent: 100 });
  });

  it('an emptied list clears old rows once the pass finishes', async () => {
    let ids = range(1, 3);
    const { client } = fakeClient({ getIds: () => ids });
    await syncBreweryLikes(client, cache, 'mer', 10);
    ids = [];
    const s = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(s).toMatchObject({ complete: true, cached: 0, likes_removed: 3 });
  });

  it('is resumable: persists the cursor every page and resumes with a small overlap', async () => {
    const { client, calls } = fakeClient({ getIds: () => range(1, 120) });
    const a = await syncBreweryLikes(client, cache, 'mer', 1);
    expect(a).toMatchObject({ complete: false, another_run_needed: true, next_offset: 50, cached: 50, total: 120, percent: 42 });
    expect(await cache.getListState('mer', BREWERY_LIKES_LIST)).toMatchObject({ next_offset: 50, complete: false, total_count: 120 });
    const b = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(calls[1].q.offset).toBe(45); // 50 - overlap
    expect(b).toMatchObject({ complete: true, cached: 120 });
  });

  it('a completed re-sync drops unliked breweries and adds new ones; a partial pass never deletes', async () => {
    let ids = range(1, 80);
    const { client } = fakeClient({ getIds: () => ids });
    await syncBreweryLikes(client, cache, 'mer', 10);
    ids = [...range(3, 70), 500]; // 1, 2 and 73–80 unliked; 500 liked
    const partial = await syncBreweryLikes(client, cache, 'mer', 1);
    expect(partial).toMatchObject({ complete: false, likes_removed: 0, cached: 80 });
    const s = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(s).toMatchObject({ complete: true, likes_added: 1, likes_removed: 10, cached: 71 });
  });

  it('stops before the rate limit with resume info, keeping progress', async () => {
    const { client, calls } = fakeClient({ getIds: () => range(1, 120), spent: 97 });
    const s = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(calls).toHaveLength(1);
    expect(s).toMatchObject({ stopped_for_rate_limit: true, another_run_needed: true, cached: 50 });
    expect(s.rate_limit?.resume_at).toEqual(expect.any(String));
    expect(s.note).toMatch(/untappd_sync_brewery_likes/);
  });

  it('a 429 mid-run stops cleanly instead of throwing', async () => {
    const { client } = fakeClient({ getIds: () => range(1, 120), fail: (n) => n === 2 });
    const s = await syncBreweryLikes(client, cache, 'mer', 10);
    expect(s).toMatchObject({ stopped_for_rate_limit: true, cached: 50, complete: false, next_offset: 50 });
  });

  it('reports coverage in cache stats and is cleared by forgetUser', async () => {
    const { client } = fakeClient({ getIds: () => range(1, 5) });
    await syncBreweryLikes(client, cache, 'mer', 10);
    const u = (await cache.stats()).users.find((x) => x.username === 'mer');
    expect(u?.brewery_likes).toMatchObject({ cached: 5, total: 5, complete: true, percent: 100 });
    const f = await cache.forgetUser('mer');
    expect(f.brewery_likes).toBe(5);
    expect(await cache.breweryLikesCount('mer')).toBe(0);
    expect((await cache.stats()).users.find((x) => x.username === 'mer')).toBeUndefined();
  });
});
