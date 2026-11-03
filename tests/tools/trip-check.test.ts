import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UntappdClient } from '../../src/client.js';
import { CheckinCache } from '../../src/cache/db.js';
import type { BreweryBeerRow, DistinctBeerRow, UserVenueItem } from '../../src/cache/store.js';
import { registerTripTools } from '../../src/tools/trip.js';
import { createTestHarness } from '../helpers.js';

const client = new UntappdClient();
const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);
let cache: CheckinCache;
let harness: Awaited<ReturnType<typeof createTestHarness>>;
const U = 'mer';
const parse = (r: unknown): Record<string, any> => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const call = async (args: Record<string, unknown>) => {
  const r = (await harness.callTool('untappd_trip_check', args)) as { isError?: boolean; content: { text: string }[] };
  if (r.isError) throw new Error(r.content[0].text);
  return parse(r);
};

const BREWERY = 10;
function distinct(bid: number, o: Partial<DistinctBeerRow> = {}): DistinctBeerRow {
  return {
    username: U, bid, beer_name: `Had ${bid}`, brewery_id: BREWERY, brewery_name: 'Coppertail Brewing Co.', beer_style: 'IPA', abv: 6,
    rating: 4, had_count: 1, first_had: '2020-01-01T00:00:00.000Z', last_had: '2020-01-01T00:00:00.000Z', ...o,
  };
}
function venue(id: number, count: number, name: string, lat: number, lng: number): UserVenueItem {
  return {
    venue: { venue_id: id, name, category: 'Brewery', address: null, city: 'Tampa', state: 'FL', country: 'US', lat, lng, is_verified: 1 },
    visit: { venue_id: id, first_visit: '2016-02-10T12:00:00.000Z', first_checkin_id: 1, recent_visit: '2025-07-05T18:00:00.000Z', recent_checkin_id: 2, total_count: count },
  };
}
function row(bid: number, rating: number, o: Partial<BreweryBeerRow> = {}): BreweryBeerRow {
  return {
    brewery_id: BREWERY, bid, beer_name: `Beer ${bid}`, style: 'IPA - American', abv: 6, rating_score: rating, rating_count: 500,
    checkin_count: 1000, in_production: true, popularity_rank: null, fetched_at: new Date().toISOString(), ...o,
  };
}
async function seedList(rows: BreweryBeerRow[], fetchedAt = new Date().toISOString(), breweryId = BREWERY, name = 'Coppertail Brewing Co.') {
  await cache.saveBreweryBeerPage({
    brewery_id: breweryId,
    brewery_name: name,
    total_count: rows.length,
    rows: rows.map((r, i) => ({ ...r, brewery_id: breweryId, popularity_rank: i, fetched_at: fetchedAt })),
    ranked_offset: 0,
    item_count: rows.length,
    restart: true,
    fetched_at: fetchedAt,
  });
}
const STANDARD_LIST = () => [
  row(1, 4.0), row(2, 3.9), row(3, 3.8), // had
  row(6, 4.1),
  row(7, 3.9), // wishlisted
  row(8, 4.3, { in_production: false }),
  row(9, 3.7, { style: 'Stout - Imperial' }),
];

// Venue 100 (Coppertail, 12 check-ins) is a derived favorite; Angry Chair (200) is ~1.2 km away.
const COPPERTAIL = { lat: 27.9601, lng: -82.4235 };
const ANGRY_CHAIR = { lat: 27.97, lng: -82.43 };

beforeEach(async () => {
  get.mockReset();
  get.mockResolvedValue(undefined as never);
  cache = CheckinCache.open(':memory:');
  // Brewery 10 is a derived favorite: 5 beers had, avg 4.0.
  await cache.upsertDistinctBeers(U, [1, 2, 3, 4, 5].map((b) => distinct(b)));
  await cache.setState(U, { beers_complete: true, beers_total: 5, last_synced_at: '2026-11-01T00:00:00.000Z' });
  await cache.upsertUserVenues(U, [
    venue(100, 12, 'Coppertail Brewing Co.', COPPERTAIL.lat, COPPERTAIL.lng),
    venue(200, 1, 'Angry Chair Brewing', ANGRY_CHAIR.lat, ANGRY_CHAIR.lng),
  ]);
  await cache.setListState(U, 'venues', { complete: true, total_count: 2, next_offset: null, last_synced_at: '2026-11-01T00:00:00.000Z' });
  await cache.upsertWishlist(U, [{ bid: 7, beer_name: 'Beer 7', brewery_id: BREWERY, brewery_name: 'Coppertail Brewing Co.', note: null, created_at: '2026-01-01T00:00:00.000Z' }], '2026-11-01T00:00:00.000Z');
  await seedList(STANDARD_LIST());
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('untappd_trip_check', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerTripTools(server, client, () => cache));
  });

  it('answers a brewery stop from the cache only: visited (via the brewery name), beers had, top not-had with the favorites boost', async () => {
    const r = await call({ username: U, places: [{ brewery_id: BREWERY, city: 'Tampa' }] });
    expect(get).not.toHaveBeenCalled();
    const p = r.places[0];
    expect(p.visited).toBe(true);
    expect(p.visits[0]).toMatchObject({ username: U, visited: true, total_visits: 12, first_visit: '2016-02-10T12:00:00.000Z' });
    expect(p.visits[0].matches[0]).toMatchObject({ venue_id: 100, favorite: { is_favorite: true, sources: ['derived'] } });
    expect(p.brewery).toMatchObject({ brewery_id: BREWERY, brewery_name: 'Coppertail Brewing Co.', beers_had: 5, source: 'cache', stale: false });
    expect(p.brewery.favorite).toMatchObject({ is_favorite: true, sources: ['derived'] });
    // 7: 3.9 + wishlist 0.5 + favorite brewery 0.25 beats 6: 4.1 + 0.25; 8 is out of production; 1–3 already had.
    expect(p.top_not_had.map((b: any) => b.bid)).toEqual([7, 6, 9]);
    expect(p.top_not_had[0]).toMatchObject({ wishlisted: true, boosted_by: ['wishlist', 'favorite_brewery'], rating: 3.9 });
    expect(p.favorite_venue).toBe(true);
    expect(r.summary).toMatchObject({ places: 1, visited: 1, api_calls_used: 0, another_run_needed: false, prefer_favorites: true });
    expect(r.freshness.beers.coverage_complete).toBe(true);
    expect(r.freshness.venues.coverage_complete).toBe(true);
  });

  it('flags and boosts a brewery the user LIKED on Untappd (source "untappd"), even with no derived history', async () => {
    const OTHER = 30;
    await seedList([row(31, 4.0), row(32, 3.8)], new Date().toISOString(), OTHER, 'Liked Only Brewing');
    await cache.upsertBreweryLikes(U, [
      { brewery_id: OTHER, brewery_name: 'Liked Only Brewing', brewery_type: null, country: null, city: 'Tampa', state: 'FL', lat: null, lng: null, liked_at: '2022-05-06T00:00:00.000Z' },
    ], '2026-11-03T00:00:00.000Z');
    const r = await call({ username: U, places: [{ brewery_id: OTHER, name: 'Liked Only Brewing' }] });
    expect(get).not.toHaveBeenCalled();
    const p = r.places[0];
    expect(p.brewery.favorite).toEqual({ is_favorite: true, sources: ['untappd'], reason: 'liked on Untappd (since 2022-05)' });
    expect(p.top_not_had[0]).toMatchObject({ bid: 31, boosted_by: ['favorite_brewery'] });
  });

  it('prefer_favorites:false ranks on global rating alone; style filters; top_n caps; out-of-production on request', async () => {
    const plain = await call({ username: U, places: [{ brewery_id: BREWERY }], prefer_favorites: false });
    expect(plain.places[0].top_not_had.map((b: any) => b.bid)).toEqual([6, 7, 9]);
    expect(plain.places[0].top_not_had[0].boosted_by).toBeUndefined();

    const stout = await call({ username: U, places: [{ brewery_id: BREWERY }], style: 'stout' });
    expect(stout.places[0].top_not_had.map((b: any) => b.bid)).toEqual([9]);

    const one = await call({ username: U, places: [{ brewery_id: BREWERY }], top_n: 1, include_out_of_production: true, prefer_favorites: false });
    expect(one.places[0].top_not_had.map((b: any) => b.bid)).toEqual([8]);
  });

  it('defaults top_n to 4', async () => {
    await seedList([...STANDARD_LIST(), row(11, 3.5), row(12, 3.4), row(13, 3.3)]);
    const r = await call({ username: U, places: [{ brewery_id: BREWERY }], prefer_favorites: false });
    expect(r.places[0].top_not_had).toHaveLength(4);
    expect(r.places[0].brewery.not_had_in_list).toBe(6);
  });

  it('hints at a favorite venue within 2 km of a stop (never the stop itself), and the radius is a parameter', async () => {
    const r = await call({ username: U, places: [{ label: 'AC', name: 'Angry Chair', city: 'Tampa' }, { venue_id: 100 }] });
    const ac = r.places[0];
    expect(ac.label).toBe('AC');
    expect(ac.visited).toBe(true);
    expect(ac.brewery).toBeUndefined();
    expect(ac.near_favorites).toHaveLength(1);
    expect(ac.near_favorites[0]).toMatchObject({ venue_id: 100, name: 'Coppertail Brewing Co.', favorite: { is_favorite: true } });
    expect(ac.near_favorites[0].distance_m).toBeGreaterThan(1000);
    expect(ac.near_favorites[0].distance_m).toBeLessThan(2000);
    expect(ac.hint).toMatch(/Near a favorite: Coppertail Brewing Co\. \(\d+ m\)/);
    // The favorite venue itself is not "near a favorite" of itself.
    expect(r.places[1].near_favorites).toBeUndefined();
    expect(r.places[1].favorite_venue).toBe(true);

    const tight = await call({ username: U, places: [{ name: 'Angry Chair' }], near_favorite_radius_m: 500 });
    expect(tight.places[0].near_favorites).toBeUndefined();
    expect(tight.places[0].hint).toBeUndefined();
  });

  it('uses a lat/lng stop as the hint centre even when it was never visited', async () => {
    const r = await call({ username: U, places: [{ lat: 27.965, lng: -82.425, radius_m: 50 }] });
    const p = r.places[0];
    expect(p.visited).toBe(false);
    expect(p.near_favorites.map((v: any) => v.venue_id)).toEqual([100]);
  });

  it('merges a manual favorite venue with the derived one (no duplicate sources)', async () => {
    await cache.addFavorite(U, 'venue', 100, 'patio', '2026-10-01T00:00:00.000Z');
    await cache.addFavorite(U, 'venue', 300, null, '2026-10-01T00:00:00.000Z'); // no coords known: never hinted
    const r = await call({ username: U, places: [{ venue_id: 100 }, { name: 'Angry Chair' }] });
    expect(r.places[0].visits[0].matches[0].favorite).toMatchObject({ sources: ['derived', 'manual'], reason: '12 check-ins since 2016; manual: patio' });
    expect(r.places[1].near_favorites.map((v: any) => v.venue_id)).toEqual([100]);
    expect(r.places[1].near_favorites[0].favorite.sources).toEqual(['derived', 'manual']);
  });

  it('fetches a missing brewery list through the 7-day cache, within api_budget', async () => {
    get.mockResolvedValue({
      total_count: 2,
      brewery: { brewery_name: 'Hidden Springs Ale Works' },
      beers: {
        count: 2,
        items: [
          { beer: { bid: 51, beer_name: 'Wildflower', beer_style: 'Saison', beer_abv: 6, rating_score: 3.8, rating_count: 10, is_in_production: 1 }, total_count: 20 },
          { beer: { bid: 52, beer_name: 'Pils', beer_style: 'Pilsner', beer_abv: 5, rating_score: 3.6, rating_count: 10, is_in_production: 1 }, total_count: 20 },
        ],
      },
    } as never);
    const r = await call({ username: U, places: [{ brewery_id: 20 }] });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('/brewery/beer_list/20');
    expect(r.places[0].brewery).toMatchObject({ brewery_name: 'Hidden Springs Ale Works', source: 'api', beers_had: 0 });
    expect(r.places[0].top_not_had.map((b: any) => b.bid)).toEqual([51, 52]);
    expect(r.places[0].visited).toBe(false);
    expect(r.summary.api_calls_used).toBe(1);

    // Second run: served from the cache.
    get.mockClear();
    const again = await call({ username: U, places: [{ brewery_id: 20 }] });
    expect(get).not.toHaveBeenCalled();
    expect(again.places[0].brewery.source).toBe('cache');
  });

  it('api_budget 0 is strictly cache-only: a missing list is reported and another_run_needed is set', async () => {
    const r = await call({ username: U, places: [{ brewery_id: 20, name: 'Hidden Springs' }], api_budget: 0 });
    expect(get).not.toHaveBeenCalled();
    expect(r.places[0].brewery).toMatchObject({ brewery_id: 20, source: 'missing', beers_had: 0 });
    expect(r.places[0].top_not_had).toEqual([]);
    expect(r.summary).toMatchObject({ partial: true, another_run_needed: true, brewery_lists_missing: 1 });
  });

  it('ranks on a stale (past-TTL) list, flagged, when the budget does not allow a refresh', async () => {
    await seedList(STANDARD_LIST(), '2026-01-01T00:00:00.000Z');
    const r = await call({ username: U, places: [{ brewery_id: BREWERY }], api_budget: 0 });
    expect(r.places[0].brewery).toMatchObject({ source: 'cache', stale: true });
    expect(r.places[0].top_not_had.length).toBeGreaterThan(0);
    expect(r.summary.another_run_needed).toBe(true);
  });

  it('a group: none_had drops beers anyone has had, and visits are per user', async () => {
    await cache.upsertDistinctBeers('chris', [distinct(6, { username: 'chris' })]);
    await cache.setState('chris', { beers_complete: true, beers_total: 1, last_synced_at: '2026-11-01T00:00:00.000Z' });
    const r = await call({ usernames: [U, 'chris'], places: [{ brewery_id: BREWERY, city: 'Tampa' }], prefer_favorites: false });
    const p = r.places[0];
    expect(p.top_not_had.map((b: any) => b.bid)).toEqual([7, 9]);
    expect(p.visits.map((v: any) => [v.username, v.visited])).toEqual([[U, true], ['chris', false]]);
    expect(p.brewery.beers_had_by).toEqual({ [U]: 5, chris: 1 });
    expect(p.visited).toBe(true);

    const any = await call({ usernames: [U, 'chris'], mode: 'any_not_had', places: [{ brewery_id: BREWERY }], prefer_favorites: false });
    const six = any.places[0].top_not_had.find((b: any) => b.bid === 6);
    expect(six).toMatchObject({ not_had_by: [U], had_by: ['chris'] });
  });

  it('rejects a place with nothing to match on, and lat without lng', async () => {
    await expect(call({ username: U, places: [{ label: 'x' }] })).rejects.toThrow(/nothing to match on/);
    await expect(call({ username: U, places: [{ lat: 27.9 }] })).rejects.toThrow(/lat and lng/);
  });
});
