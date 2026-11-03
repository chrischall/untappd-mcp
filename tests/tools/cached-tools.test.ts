import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { UntappdClient } from '../../src/client.js';
import { CheckinCache } from '../../src/cache/db.js';
import { BREWERY_BEERS_TTL_MS } from '../../src/cache/brewery-beers.js';
import { VENUE_RESPONSE_TTL_MS } from '../../src/cache/response-cache.js';
import { registerBreweryTools } from '../../src/tools/brewery.js';
import { registerVenueTools } from '../../src/tools/venue.js';
import { registerCacheTools } from '../../src/tools/cache.js';
import { createTestHarness } from '../helpers.js';

const client = new UntappdClient();
const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);
let cache: CheckinCache;
let harness: Awaited<ReturnType<typeof createTestHarness>>;

const T0 = new Date('2026-11-01T12:00:00.000Z');
function at(ms: number) {
  vi.setSystemTime(new Date(T0.getTime() + ms));
}
function parse(r: unknown): Record<string, any> {
  return JSON.parse((r as { content: { text: string }[] }).content[0].text);
}

const BEER_PAGE = {
  total_count: 2,
  beers: {
    count: 2,
    items: [
      { has_had: true, total_user_count: 4, total_count: 900, beer: { bid: 1, beer_name: 'Night Swim', beer_style: 'Porter', beer_abv: 6, rating_score: 3.9, rating_count: 800, is_in_production: 1 }, brewery: { brewery_id: 42, brewery_name: 'Coppertail Brewing Co.' } },
      { has_had: false, total_user_count: 0, total_count: 500, beer: { bid: 2, beer_name: 'Free Dive', beer_style: 'IPA', beer_abv: 6.5, rating_score: 3.7, rating_count: 400, is_in_production: 0 }, brewery: { brewery_id: 42, brewery_name: 'Coppertail Brewing Co.' } },
    ],
  },
};

describe('cache-backed read tools (brewery_beers 7-day, venue_menu / venue_activity 6-hour)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    get.mockReset();
    get.mockResolvedValue(undefined as never);
    cache = CheckinCache.open(':memory:');
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerBreweryTools(server, client, () => cache);
      registerVenueTools(server, client, () => cache);
      registerCacheTools(server, client, () => cache);
    });
  });

  it('brewery_beers: fetches once, then serves from the cache until the 7-day TTL expires', async () => {
    get.mockResolvedValue(BEER_PAGE as never);
    const a = parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 42 }));
    expect(a).toMatchObject({ brewery_id: 42, brewery_name: 'Coppertail Brewing Co.', total_count: 2, source: 'api' });
    expect(a.beers.items[0]).toEqual({ bid: 1, name: 'Night Swim', style: 'Porter', abv: 6, rating: 3.9, rating_count: 800, checkin_count: 900, in_production: true });
    expect(a.beers.items[1].in_production).toBe(false);

    at(BREWERY_BEERS_TTL_MS - 1000);
    const b = parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 42 }));
    expect(b.source).toBe('cache');
    expect(b.fetched_at).toBe(T0.toISOString());
    expect(get).toHaveBeenCalledTimes(1);

    at(BREWERY_BEERS_TTL_MS + 1000);
    expect(parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 42 })).source).toBe('api');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('brewery_beers: refresh:true re-fetches a fresh list', async () => {
    get.mockResolvedValue(BEER_PAGE as never);
    await harness.callTool('untappd_brewery_beers', { brewery_id: 42 });
    const r = parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 42, refresh: true }));
    expect(r.source).toBe('api');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith('/brewery/beer_list/42', { limit: undefined, offset: undefined, sort: undefined });
  });

  it('brewery_beers: never surfaces the authenticated account\'s have_had once the cache is on', async () => {
    get.mockResolvedValue(BEER_PAGE as never);
    const text = (await harness.callTool('untappd_brewery_beers', { brewery_id: 42 })) as { content: { text: string }[] };
    expect(text.content[0].text).not.toMatch(/have_had|has_had|your_count/);
  });

  it('brewery_beers: view "full" always goes upstream and returns the raw page, but still seeds the cache', async () => {
    get.mockResolvedValue(BEER_PAGE as never);
    expect(parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 42, view: 'full' }))).toEqual(BEER_PAGE);
    expect(parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 42 })).source).toBe('cache');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('venue_menu: a repeated identical call within 6 hours makes no API call; after it, re-fetches', async () => {
    get.mockResolvedValue({ venue: { menu: { count: 1, items: [] } } } as never);
    const a = parse(await harness.callTool('untappd_venue_menu', { venue_id: 5 }));
    const calls = get.mock.calls.length;
    expect(a.cache).toMatchObject({ hit: false, fetched_at: T0.toISOString() });

    at(VENUE_RESPONSE_TTL_MS - 1000);
    const b = parse(await harness.callTool('untappd_venue_menu', { venue_id: 5 }));
    expect(b.cache).toMatchObject({ hit: true, fetched_at: T0.toISOString() });
    expect(get.mock.calls.length).toBe(calls);
    const { cache: _a, ...restA } = a;
    const { cache: _b, ...restB } = b;
    expect(restB).toEqual(restA);

    // Different paging params are a different entry.
    await harness.callTool('untappd_venue_menu', { venue_id: 5, section_offset: 3 });
    expect(get.mock.calls.length).toBeGreaterThan(calls);
    const afterOther = get.mock.calls.length;

    at(VENUE_RESPONSE_TTL_MS + 1000);
    expect(parse(await harness.callTool('untappd_venue_menu', { venue_id: 5 })).cache.hit).toBe(false);
    expect(get.mock.calls.length).toBeGreaterThan(afterOther);
  });

  it('venue_menu: refresh:true bypasses a fresh entry', async () => {
    get.mockResolvedValue({ venue: { menu: { count: 1, items: [] } } } as never);
    await harness.callTool('untappd_venue_menu', { venue_id: 6 });
    const n = get.mock.calls.length;
    expect(parse(await harness.callTool('untappd_venue_menu', { venue_id: 6, refresh: true })).cache.hit).toBe(false);
    expect(get.mock.calls.length).toBeGreaterThan(n);
  });

  it('venue_activity: cached for 6 hours per (venue, limit, max_id); view applies to the cached raw response', async () => {
    get.mockResolvedValue({ checkins: { items: [{ checkin_id: 7, beer: { bid: 3, beer_name: 'X' }, user: { user_name: 'u' } }] } } as never);
    const a = parse(await harness.callTool('untappd_venue_activity', { venue_id: 100 }));
    expect(a.cache.hit).toBe(false);
    at(60_000);
    const full = parse(await harness.callTool('untappd_venue_activity', { venue_id: 100, view: 'full' }));
    expect(full.cache.hit).toBe(true);
    expect(full.checkins.items[0].beer.beer_name).toBe('X'); // raw shape
    expect(get).toHaveBeenCalledTimes(1);

    await harness.callTool('untappd_venue_activity', { venue_id: 100, max_id: 5 });
    expect(get).toHaveBeenCalledTimes(2);

    at(VENUE_RESPONSE_TTL_MS + 1);
    expect(parse(await harness.callTool('untappd_venue_activity', { venue_id: 100 })).cache.hit).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);

    expect(parse(await harness.callTool('untappd_venue_activity', { venue_id: 100, refresh: true })).cache.hit).toBe(false);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('untappd_sync_wishlist mirrors the wishlist into the cache, and cache_status reports it', async () => {
    get.mockImplementation((async (path: string) => {
      if (path === '/user/wishlist/mer') {
        return { total_count: 1, beers: { items: [{ created_at: '2025-01-01T00:00:00Z', beer: { bid: 9, beer_name: 'W' }, brewery: { brewery_id: 1, brewery_name: 'B' } }] } };
      }
      return {};
    }) as never);
    const s = parse(await harness.callTool('untappd_sync_wishlist', { username: 'mer' }));
    expect(s).toMatchObject({ username: 'mer', cached: 1, complete: true, another_run_needed: false });
    const st = parse(await harness.callTool('untappd_cache_status', {}));
    const u = st.users.find((x: { username: string }) => x.username === 'mer');
    expect(u.wishlist).toMatchObject({ cached: 1, total: 1, complete: true });
  });
});
