import { describe, it, expect, beforeEach } from 'vitest';
import type { UntappdClient } from '../src/client.js';
import { CheckinCache } from '../src/cache/db.js';
import { mapBreweryBeerItem } from '../src/cache/store.js';
import { BREWERY_BEERS_TTL_MS, getBreweryBeers } from '../src/cache/brewery-beers.js';

// One /brewery/beer_list item, shaped like the live capture (tests/tools/read.test.ts).
function beerItem(bid: number, over: Record<string, unknown> = {}, itemOver: Record<string, unknown> = {}) {
  return {
    total_user_count: 3,
    has_had: true, // the AUTHENTICATED account's — must never be cached
    total_count: 1000 - bid,
    beer: {
      bid,
      beer_name: `Beer ${bid}`,
      beer_style: bid % 2 ? 'IPA - American' : 'Stout',
      beer_abv: 4 + (bid % 5),
      rating_score: 3 + (bid % 10) / 10,
      rating_count: 500 - bid,
      is_in_production: bid === 7 ? 0 : 1,
      ...over,
    },
    brewery: { brewery_id: 42, brewery_name: 'Coppertail Brewing Co.' },
    ...itemOver,
  };
}

/** A beer_list route over `bids` (popularity order) honouring limit/offset; `sort` reorders by rating. */
function fakeClient(getBids: () => number[]) {
  const calls: Array<{ path: string; q: Record<string, unknown> }> = [];
  const client = {
    async get(path: string, q: Record<string, unknown> = {}) {
      calls.push({ path, q });
      let bids = getBids();
      if (q.sort === 'rating') bids = [...bids].sort((a, b) => (b % 10) - (a % 10));
      const offset = Number(q.offset ?? 0);
      const limit = Number(q.limit ?? 25);
      const page = bids.slice(offset, offset + limit);
      return { total_count: bids.length, beers: { count: page.length, items: page.map((b) => beerItem(b)) } };
    },
  } as unknown as UntappdClient;
  return { client, calls };
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
const T0 = new Date('2026-11-01T12:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('mapBreweryBeerItem', () => {
  it('maps the global facts and never the have_had / your-count fields', () => {
    const row = mapBreweryBeerItem(42, beerItem(7), T0.toISOString(), 3)!;
    expect(row).toEqual({
      brewery_id: 42,
      bid: 7,
      beer_name: 'Beer 7',
      style: 'IPA - American',
      abv: 6,
      ibu: null,
      rating_score: 3.7,
      rating_count: 493,
      checkin_count: 993,
      in_production: false,
      popularity_rank: 3,
      fetched_at: T0.toISOString(),
    });
    expect(JSON.stringify(row)).not.toMatch(/have_had|has_had|user_count/);
  });

  it('rejects an item without a bid', () => {
    expect(mapBreweryBeerItem(42, { beer: {} }, T0.toISOString(), null)).toBeNull();
  });
});

describe('getBreweryBeers (brewery beer-list cache, 7-day TTL)', () => {
  let cache: CheckinCache;
  beforeEach(() => {
    cache = CheckinCache.open(':memory:');
  });

  it('a miss fetches from the API and stores the page; the same window is then served from the cache', async () => {
    const { client, calls } = fakeClient(() => range(1, 10));
    const a = await getBreweryBeers(client, cache, 42, { now: T0 });
    expect(a.source).toBe('api');
    expect(a.beers.map((b) => b.bid)).toEqual(range(1, 10));
    expect(a).toMatchObject({ brewery_id: 42, brewery_name: 'Coppertail Brewing Co.', total_count: 10, fetched_at: T0.toISOString() });
    expect(a.expires_at).toBe(later(BREWERY_BEERS_TTL_MS).toISOString());

    const b = await getBreweryBeers(client, cache, 42, { now: later(60_000) });
    expect(b.source).toBe('cache');
    expect(b.beers.map((x) => x.bid)).toEqual(range(1, 10));
    expect(b.fetched_at).toBe(T0.toISOString());
    expect(calls).toHaveLength(1);
  });

  it('defaults the TTL to 7 days', () => {
    expect(BREWERY_BEERS_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('TTL expiry: a list older than 7 days is re-fetched, and beers gone from the new list are dropped', async () => {
    let bids = range(1, 10);
    const { client, calls } = fakeClient(() => bids);
    await getBreweryBeers(client, cache, 42, { now: T0 });

    // Just inside the TTL: still cached.
    expect((await getBreweryBeers(client, cache, 42, { now: later(BREWERY_BEERS_TTL_MS - 1) })).source).toBe('cache');
    expect(calls).toHaveLength(1);

    bids = [...range(1, 8), 99]; // 9 and 10 retired, 99 is new
    const r = await getBreweryBeers(client, cache, 42, { now: later(BREWERY_BEERS_TTL_MS + 1) });
    expect(r.source).toBe('api');
    expect(calls).toHaveLength(2);
    const list = await cache.getBreweryBeerList(42);
    expect(list?.beers.map((b) => b.bid).sort((x, y) => x - y)).toEqual([...range(1, 8), 99]);
    expect(list?.fetched_at).toBe(later(BREWERY_BEERS_TTL_MS + 1).toISOString());
  });

  it('honours a custom ttlMs', async () => {
    const { client, calls } = fakeClient(() => range(1, 5));
    await getBreweryBeers(client, cache, 42, { now: T0 });
    expect((await getBreweryBeers(client, cache, 42, { now: later(3_600_001), ttlMs: 3_600_000 })).source).toBe('api');
    expect(calls).toHaveLength(2);
  });

  it('refresh:true re-fetches even when the cached list is fresh', async () => {
    const { client, calls } = fakeClient(() => range(1, 5));
    await getBreweryBeers(client, cache, 42, { now: T0 });
    const r = await getBreweryBeers(client, cache, 42, { now: later(1000), refresh: true });
    expect(r.source).toBe('api');
    expect(calls).toHaveLength(2);
    expect((await cache.getBreweryBeerList(42))?.fetched_at).toBe(later(1000).toISOString());
  });

  it('a window beyond the cached popularity prefix goes to the API and extends the prefix', async () => {
    const { client, calls } = fakeClient(() => range(1, 120));
    await getBreweryBeers(client, cache, 42, { now: T0, limit: 50 });
    expect((await cache.getBreweryBeerList(42))?.ranked_count).toBe(50);

    const p2 = await getBreweryBeers(client, cache, 42, { now: later(1), limit: 50, offset: 50 });
    expect(p2.source).toBe('api');
    expect(calls).toHaveLength(2);
    expect((await cache.getBreweryBeerList(42))?.ranked_count).toBe(100);

    // A window inside the prefix is now served locally, in popularity order.
    const mid = await getBreweryBeers(client, cache, 42, { now: later(2), limit: 10, offset: 45 });
    expect(mid.source).toBe('cache');
    expect(mid.beers.map((b) => b.bid)).toEqual(range(46, 10));
    // The appended page keeps the snapshot's original TTL clock.
    expect(mid.fetched_at).toBe(T0.toISOString());
  });

  it('a window past the end of a fully cached list is served from the cache (not re-fetched)', async () => {
    const { client, calls } = fakeClient(() => range(1, 10));
    await getBreweryBeers(client, cache, 42, { now: T0, limit: 50 });
    const r = await getBreweryBeers(client, cache, 42, { now: later(1), limit: 25, offset: 5 });
    expect(r.source).toBe('cache');
    expect(r.beers.map((b) => b.bid)).toEqual(range(6, 5));
    expect(calls).toHaveLength(1);
  });

  it('a non-default sort is served locally only when the whole list is cached', async () => {
    const { client, calls } = fakeClient(() => range(1, 60));
    await getBreweryBeers(client, cache, 42, { now: T0, limit: 50 });
    // Partial list: a rating sort over just the top 50 would be wrong, so it goes upstream.
    const partial = await getBreweryBeers(client, cache, 42, { now: later(1), sort: 'rating', limit: 5 });
    expect(partial.source).toBe('api');
    expect(calls[1].q).toMatchObject({ sort: 'rating', limit: 5 });

    await getBreweryBeers(client, cache, 42, { now: later(2), limit: 50, offset: 50 });
    expect(calls).toHaveLength(3);
    const local = await getBreweryBeers(client, cache, 42, { now: later(3), sort: 'rating', limit: 5 });
    expect(local.source).toBe('cache');
    expect(calls).toHaveLength(3);
    const ratings = local.beers.map((b) => b.rating_score!);
    expect(ratings).toEqual([...ratings].sort((x, y) => y - x));
    expect(ratings[0]).toBe(3.9);
  });

  it('never stores or returns the authenticated account\'s have_had', async () => {
    const { client } = fakeClient(() => range(1, 3));
    // `raw` is Untappd's response, kept only for view:"full" — everything else is ours.
    const { raw: _raw, ...api } = await getBreweryBeers(client, cache, 42, { now: T0 });
    const hit = await getBreweryBeers(client, cache, 42, { now: later(1) });
    expect(hit.raw).toBeUndefined();
    expect(JSON.stringify(await cache.getBreweryBeerList(42))).not.toMatch(/have_had|has_had|user_count/);
    expect(JSON.stringify(api)).not.toMatch(/have_had|has_had|user_count/);
    expect(JSON.stringify(hit)).not.toMatch(/have_had|has_had|user_count/);
  });

  it('works without a cache (plain API pass-through)', async () => {
    const { client, calls } = fakeClient(() => range(1, 3));
    const r = await getBreweryBeers(client, undefined, 42, { now: T0 });
    expect(r.source).toBe('api');
    expect(r.beers).toHaveLength(3);
    await getBreweryBeers(client, undefined, 42, { now: T0 });
    expect(calls).toHaveLength(2);
  });
});
