import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimitError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../src/client.js';
import { CheckinCache } from '../src/cache/db.js';
import { mapWishlistItem } from '../src/cache/store.js';
import { syncWishlist, WISHLIST_LIST } from '../src/cache/sync-wishlist.js';
import type { ApiCallObservation } from '../src/ratelimit.js';

// One user/wishlist item, shaped like the live v4 response.
function wishItem(bid: number) {
  return {
    created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA - American', beer_abv: 6.5 },
    brewery: { brewery_id: 1000 + (bid % 3), brewery_name: `Brewery ${bid % 3}` },
  };
}

/** A wishlist route: at most 25 per page whatever the limit, next offset in pagination.offset. */
function fakeClient(opts: { getBids: () => number[]; spent?: number; fail?: (n: number) => boolean }) {
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
      const bids = opts.getBids();
      const offset = Number(q.offset ?? 0);
      const page = bids.slice(offset, offset + 25);
      return {
        total_count: bids.length,
        beers: { count: page.length, items: page.map(wishItem) },
        pagination: { offset: offset + page.length },
      };
    },
  } as unknown as UntappdClient;
  return { client, calls };
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe('mapWishlistItem', () => {
  it('maps beer, brewery and the added date', () => {
    expect(mapWishlistItem(wishItem(7))).toEqual({
      bid: 7,
      beer_name: 'Beer 7',
      brewery_id: 1001,
      brewery_name: 'Brewery 1',
      style: 'IPA - American',
      abv: 6.5,
      added_at: '2025-07-05T18:23:11.000Z',
    });
    expect(mapWishlistItem({ beer: {} })).toBeNull();
  });
});

describe('syncWishlist', () => {
  let cache: CheckinCache;
  beforeEach(() => {
    cache = CheckinCache.open(':memory:');
  });

  it('mirrors the whole wishlist, advancing by the returned offset (25/page despite asking for 50)', async () => {
    const { client, calls } = fakeClient({ getBids: () => range(1, 60) });
    const s = await syncWishlist(client, cache, 'Mer', 10);
    expect(calls.map((c) => c.q.offset)).toEqual([0, 25, 50]);
    expect(calls[0]).toMatchObject({ path: '/user/wishlist/Mer', q: { limit: 50, sort: 'date' } });
    expect(s).toMatchObject({ wishlist_added: 60, wishlist_removed: 0, cached: 60, total: 60, complete: true, another_run_needed: false, pages_fetched: 3 });
    expect((await cache.getWishlist('mer')).length).toBe(60);
    expect((await cache.getWishlist('mer', [5, 999])).map((r) => r.bid)).toEqual([5]);
  });

  it('is resumable: persists the cursor every page and resumes with a small overlap', async () => {
    const { client, calls } = fakeClient({ getBids: () => range(1, 60) });
    const a = await syncWishlist(client, cache, 'mer', 1);
    expect(a).toMatchObject({ complete: false, another_run_needed: true, next_offset: 25, cached: 25 });
    expect(await cache.getListState('mer', WISHLIST_LIST)).toMatchObject({ next_offset: 25, complete: false, total_count: 60 });
    const b = await syncWishlist(client, cache, 'mer', 10);
    expect(calls[1].q.offset).toBe(20); // 25 - overlap
    expect(b).toMatchObject({ complete: true, cached: 60 });
  });

  it('a completed re-sync drops beers removed from the wishlist and adds new ones', async () => {
    let bids = range(1, 30);
    const { client } = fakeClient({ getBids: () => bids });
    await syncWishlist(client, cache, 'mer', 10);
    bids = [...range(3, 28), 77]; // 1 and 2 removed (drunk!), 77 added
    const s = await syncWishlist(client, cache, 'mer', 10);
    expect(s).toMatchObject({ wishlist_added: 1, wishlist_removed: 2, cached: 29, complete: true });
    const have = (await cache.getWishlist('mer')).map((r) => r.bid).sort((x, y) => x - y);
    expect(have).toEqual([...range(3, 28), 77]);
  });

  it('removals are not applied until a pass finishes (a partial pass never deletes)', async () => {
    let bids = range(1, 60);
    const { client } = fakeClient({ getBids: () => bids });
    await syncWishlist(client, cache, 'mer', 10);
    bids = range(1, 50);
    const s = await syncWishlist(client, cache, 'mer', 1);
    expect(s).toMatchObject({ complete: false, wishlist_removed: 0, cached: 60 });
    const t = await syncWishlist(client, cache, 'mer', 10);
    expect(t).toMatchObject({ complete: true, wishlist_removed: 10, cached: 50 });
  });

  it('stops before the rate limit with resume info, keeping progress', async () => {
    const { client, calls } = fakeClient({ getBids: () => range(1, 60), spent: 97 });
    const s = await syncWishlist(client, cache, 'mer', 10);
    expect(calls).toHaveLength(1);
    expect(s).toMatchObject({ stopped_for_rate_limit: true, another_run_needed: true, cached: 25 });
    expect(s.rate_limit?.resume_at).toEqual(expect.any(String));
  });

  it('a 429 mid-run stops cleanly instead of throwing', async () => {
    const { client } = fakeClient({ getBids: () => range(1, 60), fail: (n) => n === 2 });
    const s = await syncWishlist(client, cache, 'mer', 10);
    expect(s).toMatchObject({ stopped_for_rate_limit: true, cached: 25, complete: false });
  });

  it('an empty wishlist completes and clears any old rows', async () => {
    let bids = range(1, 3);
    const { client } = fakeClient({ getBids: () => bids });
    await syncWishlist(client, cache, 'mer', 10);
    bids = [];
    const s = await syncWishlist(client, cache, 'mer', 10);
    expect(s).toMatchObject({ complete: true, cached: 0, wishlist_removed: 3 });
  });

  it('reports wishlist coverage in cache stats and is cleared by forgetUser', async () => {
    const { client } = fakeClient({ getBids: () => range(1, 5) });
    await syncWishlist(client, cache, 'mer', 10);
    const u = (await cache.stats()).users.find((x) => x.username === 'mer');
    expect(u?.wishlist).toMatchObject({ cached: 5, total: 5, complete: true });
    const f = await cache.forgetUser('mer');
    expect(f.wishlist).toBe(5);
    expect(await cache.wishlistCount('mer')).toBe(0);
  });
});
