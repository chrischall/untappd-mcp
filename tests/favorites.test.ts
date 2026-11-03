import { describe, it, expect, beforeEach } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import type { CheckinRow, DistinctBeerRow, UserVenueItem } from '../src/cache/store.js';
import {
  DEFAULT_FAVORITE_THRESHOLDS,
  deriveFavorites,
  favoriteLookup,
  listFavorites,
  monthSpan,
} from '../src/cache/favorites.js';

const U = 'mer';

function distinct(bid: number, o: Partial<DistinctBeerRow> = {}): DistinctBeerRow {
  return {
    username: U,
    bid,
    beer_name: `Beer ${bid}`,
    brewery_id: 1,
    brewery_name: 'Brew One',
    beer_style: 'IPA',
    abv: 6,
    rating: null,
    had_count: 1,
    first_had: '2020-01-01T00:00:00.000Z',
    last_had: '2020-01-01T00:00:00.000Z',
    ...o,
  };
}

function checkin(id: number, bid: number, o: Partial<CheckinRow> = {}): CheckinRow {
  return {
    checkin_id: id,
    username: U,
    bid,
    beer_name: `Beer ${bid}`,
    brewery_id: 9,
    brewery_name: 'Checkin Brewery',
    beer_style: 'Stout',
    abv: 8,
    rating: null,
    comment: null,
    venue_id: null,
    venue_name: null,
    created_at: '2024-01-01T00:00:00.000Z',
    ...o,
  };
}

function venue(id: number, count: number, first: string, recent: string, name = `Venue ${id}`): UserVenueItem {
  return {
    venue: { venue_id: id, name, category: 'Bar', address: null, city: 'Tampa', state: 'FL', country: 'US', lat: 27.9, lng: -82.4, is_verified: 1 },
    visit: { venue_id: id, first_visit: first, first_checkin_id: id * 10, recent_visit: recent, recent_checkin_id: id * 10 + 1, total_count: count },
  };
}

/** n beers for one brewery with the given ratings (null = unrated), bids from `start`. */
function breweryBeers(breweryId: number, start: number, ratings: Array<number | null>): DistinctBeerRow[] {
  return ratings.map((r, i) => distinct(start + i, { brewery_id: breweryId, brewery_name: `Brewery ${breweryId}`, rating: r }));
}

describe('monthSpan', () => {
  it('counts calendar months inclusively', () => {
    expect(monthSpan('2020-01-31T23:00:00.000Z', '2020-03-01T00:00:00.000Z')).toBe(3);
    expect(monthSpan('2020-01-01T00:00:00.000Z', '2020-02-28T00:00:00.000Z')).toBe(2);
    expect(monthSpan('2020-05-10T00:00:00.000Z', '2020-05-20T00:00:00.000Z')).toBe(1);
    expect(monthSpan('2019-12-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')).toBe(2);
    expect(monthSpan(null, '2020-01-01T00:00:00.000Z')).toBe(0);
  });
});

describe('derived favorite venues', () => {
  let cache: CheckinCache;
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await cache.upsertUserVenues(U, [
      venue(1, 5, '2015-06-01T00:00:00.000Z', '2015-06-20T00:00:00.000Z'), // exactly 5 check-ins → in
      venue(2, 4, '2015-06-01T00:00:00.000Z', '2015-07-20T00:00:00.000Z'), // 4, 2 months → out
      venue(3, 3, '2020-01-15T00:00:00.000Z', '2020-03-02T00:00:00.000Z'), // 3 visits over Jan–Mar → in
      venue(4, 3, '2020-01-15T00:00:00.000Z', '2020-02-27T00:00:00.000Z'), // 3 visits, Jan–Feb → out
      venue(5, 2, '2010-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'), // 2 visits can't cover 3 distinct months → out
      venue(6, 12, '2015-03-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'), // 12 → in, ranks first
    ]);
  });

  it('applies the >= 5 check-ins OR >= 3 distinct months rule at its edges, ranked by total_count', async () => {
    const r = await deriveFavorites(cache, U, 'venue');
    expect(r.map((f) => f.id)).toEqual([6, 1, 3]);
    expect(r[0]).toMatchObject({ kind: 'venue', id: 6, name: 'Venue 6', reason: '12 check-ins since 2015' });
    expect(r[1].reason).toBe('5 check-ins since 2015');
    expect(r[2].reason).toBe('3 check-ins over 3 months (2020-01 to 2020-03)');
  });

  it('takes every threshold as a parameter', async () => {
    const strict = await deriveFavorites(cache, U, 'venue', { venue_min_checkins: 6, venue_min_months: 100 });
    expect(strict.map((f) => f.id)).toEqual([6]);
    const loose = await deriveFavorites(cache, U, 'venue', { venue_min_checkins: 4, venue_min_months: 2 });
    expect(loose.map((f) => f.id)).toEqual([6, 1, 2, 3, 4, 5]);
  });

  it('can be restricted to given ids', async () => {
    expect((await deriveFavorites(cache, U, 'venue', {}, [1, 2, 99])).map((f) => f.id)).toEqual([1]);
  });
});

describe('derived favorite breweries', () => {
  let cache: CheckinCache;
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await cache.upsertDistinctBeers(U, [
      ...breweryBeers(10, 100, [3.75, 3.75, 3.75, 3.75, 3.75]), // 5 beers avg exactly 3.75 → in
      ...breweryBeers(11, 200, [3.75, 3.75, 3.75, 3.75, 3.7]), // avg 3.74 → out
      ...breweryBeers(12, 300, [4.5, 4.5, 4.5, 4.5]), // only 4 beers → out
      ...breweryBeers(13, 400, Array(15).fill(2)), // 15 beers, any rating → in
      ...breweryBeers(14, 500, Array(14).fill(2)), // 14 beers, low rating → out
      ...breweryBeers(15, 600, [4.25, 4.0, null, null, null]), // unrated beers don't drag the average → in (avg 4.125)
    ]);
  });

  it('applies (>= 5 beers AND avg >= 3.75) OR >= 15 beers at the edges', async () => {
    const r = await deriveFavorites(cache, U, 'brewery');
    expect(r.map((f) => f.id).sort()).toEqual([10, 13, 15]);
    const byId = new Map(r.map((f) => [f.id, f]));
    expect(byId.get(10)!.reason).toBe('avg 3.75 across 5 beers');
    expect(byId.get(13)!.reason).toBe('15 beers had (avg 2)');
    expect(byId.get(15)!.reason).toBe('avg 4.13 across 2 rated of 5 beers');
    expect(byId.get(10)!.name).toBe('Brewery 10');
  });

  it('ranks by a blend of beer count and average rating', async () => {
    const r = await deriveFavorites(cache, U, 'brewery');
    // 15 beers @ 2.0 vs 5 @ 3.75 vs 5 @ 4.125: the high-rated small lists win, and count still matters.
    expect(r.map((f) => f.id)).toEqual([15, 10, 13]);
    expect(r[0].score!).toBeGreaterThan(r[1].score!);
  });

  it('takes every threshold as a parameter', async () => {
    const r = await deriveFavorites(cache, U, 'brewery', { brewery_min_beers: 4, brewery_min_avg_rating: 4.5, brewery_min_beers_any_rating: 14 });
    expect(r.map((f) => f.id).sort()).toEqual([12, 13, 14]);
  });

  it('counts beers known only from check-ins too', async () => {
    const c = CheckinCache.open(':memory:');
    await c.upsertCheckins(U, [1, 2, 3, 4, 5].map((b) => checkin(b, 900 + b, { rating: 4 })));
    const r = await deriveFavorites(c, U, 'brewery');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 9, name: 'Checkin Brewery', reason: 'avg 4 across 5 beers' });
  });
});

describe('derived favorite beers', () => {
  let cache: CheckinCache;
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await cache.upsertDistinctBeers(U, [
      distinct(1, { rating: 4.25 }), // edge → in
      distinct(2, { rating: 4.24 }), // out
      distinct(3, { had_count: 3 }), // edge → in
      distinct(4, { had_count: 2 }), // out
      distinct(5, { rating: 4.5, had_count: 7 }), // both → in
    ]);
    // A beer only in check-ins, had three times.
    await cache.upsertCheckins(U, [checkin(1001, 6), checkin(1002, 6), checkin(1003, 6)]);
  });

  it('applies rated >= 4.25 OR had >= 3 times at the edges', async () => {
    const r = await deriveFavorites(cache, U, 'beer');
    expect(r.map((f) => f.id).sort()).toEqual([1, 3, 5, 6]);
    const byId = new Map(r.map((f) => [f.id, f]));
    expect(byId.get(1)!.reason).toBe('rated 4.25');
    expect(byId.get(3)!.reason).toBe('had 3 times');
    expect(byId.get(5)!.reason).toBe('rated 4.5, had 7 times');
    expect(byId.get(6)!.reason).toBe('had 3 times');
  });

  it('takes the thresholds as parameters', async () => {
    const r = await deriveFavorites(cache, U, 'beer', { beer_min_rating: 4.2, beer_min_times_had: 8 });
    expect(r.map((f) => f.id).sort()).toEqual([1, 2, 5]);
  });

  it('exposes the spec defaults', () => {
    expect(DEFAULT_FAVORITE_THRESHOLDS).toEqual({
      venue_min_checkins: 5,
      venue_min_months: 3,
      brewery_min_beers: 5,
      brewery_min_avg_rating: 3.75,
      brewery_min_beers_any_rating: 15,
      beer_min_rating: 4.25,
      beer_min_times_had: 3,
    });
  });
});

describe('manual favorites', () => {
  let cache: CheckinCache;
  beforeEach(() => {
    cache = CheckinCache.open(':memory:');
  });

  it('adds, updates the note without moving created_at, lists and removes', async () => {
    const a = await cache.addFavorite('Mer', 'beer', 5, 'great on cask', '2026-01-01T00:00:00.000Z');
    expect(a).toEqual({ added: true, note: 'great on cask', created_at: '2026-01-01T00:00:00.000Z' });
    const b = await cache.addFavorite('mer', 'beer', 5, 'even better on draft', '2026-02-01T00:00:00.000Z');
    expect(b).toEqual({ added: false, note: 'even better on draft', created_at: '2026-01-01T00:00:00.000Z' });
    // No note given keeps the existing one.
    expect((await cache.addFavorite('mer', 'beer', 5, undefined, '2026-03-01T00:00:00.000Z')).note).toBe('even better on draft');
    await cache.addFavorite('mer', 'venue', 5, null, '2026-01-02T00:00:00.000Z');
    expect((await cache.getManualFavorites('MER')).map((f) => `${f.kind}:${f.id}`)).toEqual(['venue:5', 'beer:5']);
    expect((await cache.getManualFavorites('mer', { kind: 'beer' })).map((f) => f.id)).toEqual([5]);
    expect(await cache.removeFavorite('mer', 'beer', 5)).toBe(true);
    expect(await cache.removeFavorite('mer', 'beer', 5)).toBe(false);
    expect((await cache.getManualFavorites('mer')).map((f) => f.kind)).toEqual(['venue']);
  });

  it('is cleared by forgetUser', async () => {
    await cache.addFavorite('mer', 'brewery', 1, null, '2026-01-01T00:00:00.000Z');
    const removed = await cache.forgetUser('mer');
    expect(removed).toMatchObject({ favorites: 1 });
    expect(await cache.getManualFavorites('mer')).toEqual([]);
  });

  it('names a manual favorite from what the cache knows', async () => {
    await cache.upsertDistinctBeers(U, [distinct(7, { beer_name: 'Jai Alai', brewery_id: 3, brewery_name: 'Cigar City' })]);
    await cache.upsertUserVenues(U, [venue(8, 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'Ulele')]);
    await cache.addFavorite(U, 'beer', 7, null, '2026-01-01T00:00:00.000Z');
    await cache.addFavorite(U, 'brewery', 3, null, '2026-01-01T00:00:00.000Z');
    await cache.addFavorite(U, 'venue', 8, null, '2026-01-01T00:00:00.000Z');
    await cache.addFavorite(U, 'venue', 99, null, '2026-01-01T00:00:00.000Z');
    const names = Object.fromEntries((await cache.getManualFavorites(U)).map((f) => [`${f.kind}:${f.id}`, f.name]));
    expect(names).toEqual({ 'beer:7': 'Jai Alai', 'brewery:3': 'Cigar City', 'venue:8': 'Ulele', 'venue:99': null });
  });
});

describe('merged favorites (manual + derived)', () => {
  let cache: CheckinCache;
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await cache.upsertDistinctBeers(U, [distinct(1, { rating: 4.5 }), distinct(2, { rating: 3 })]);
    await cache.addFavorite(U, 'beer', 1, 'the one', '2026-01-01T00:00:00.000Z');
    await cache.addFavorite(U, 'beer', 2, null, '2026-01-01T00:00:00.000Z');
  });

  it('a beer that is both manual and derived is listed ONCE with both sources', async () => {
    const r = await listFavorites(cache, U, { kind: 'beer' });
    expect(r.map((f) => f.id)).toEqual([1, 2]);
    expect(r[0]).toMatchObject({
      kind: 'beer',
      id: 1,
      is_favorite: true,
      sources: ['derived', 'manual'],
      reason: 'rated 4.5; manual: the one',
      note: 'the one',
    });
    expect(r[1]).toMatchObject({ id: 2, sources: ['manual'], reason: 'added manually' });
  });

  it('filters by source', async () => {
    expect((await listFavorites(cache, U, { kind: 'beer', source: 'derived' })).map((f) => f.id)).toEqual([1]);
    expect((await listFavorites(cache, U, { kind: 'beer', source: 'manual' })).map((f) => f.id)).toEqual([1, 2]);
    expect(await listFavorites(cache, U, { source: 'untappd' })).toEqual([]);
  });

  it('favoriteLookup answers per id with merged sources, and not-favorite otherwise', async () => {
    const idx = await favoriteLookup(cache, [U], { beer: [1, 2, 3] });
    expect(idx.get('beer', 1)).toEqual({ is_favorite: true, sources: ['derived', 'manual'], reason: 'rated 4.5; manual: the one' });
    expect(idx.get('beer', 2)).toEqual({ is_favorite: true, sources: ['manual'], reason: 'added manually' });
    expect(idx.get('beer', 3)).toEqual({ is_favorite: false, sources: [], reason: null });
    expect(idx.get('venue', 1).is_favorite).toBe(false);
  });

  it('favoriteLookup over a group merges users and names who', async () => {
    await cache.upsertDistinctBeers('bob', [{ ...distinct(1, { had_count: 4 }), username: 'bob' }]);
    const idx = await favoriteLookup(cache, [U, 'bob'], { beer: [1] });
    expect(idx.get('beer', 1)).toEqual({
      is_favorite: true,
      sources: ['derived', 'manual'],
      reason: 'mer: rated 4.5; mer: manual: the one; bob: had 4 times',
    });
  });
});

describe('Untappd brewery likes as the "untappd" favorite source', () => {
  let cache: CheckinCache;
  const like = (id: number, name: string, likedAt: string | null = '2021-03-04T00:00:00.000Z') => ({
    brewery_id: id, brewery_name: name, brewery_type: 'Micro Brewery', country: 'United States', city: 'Tampa', state: 'FL',
    lat: 27.96, lng: -82.42, liked_at: likedAt,
  });
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    // Brewery 1: derived (5 beers, avg 4) AND liked AND manual. Brewery 2: liked only. Brewery 3: derived only.
    await cache.upsertDistinctBeers(U, [...breweryBeers(1, 100, [4, 4, 4, 4, 4]), ...breweryBeers(3, 200, [4, 4, 4, 4, 4])]);
    await cache.addFavorite(U, 'brewery', 1, 'home team', '2026-01-01T00:00:00.000Z');
    await cache.upsertBreweryLikes(U, [like(1, 'Brewery 1'), like(2, 'Liked Only Co.', '2022-05-06T00:00:00.000Z')], '2026-11-03T00:00:00.000Z');
  });

  it('a liked brewery is a favorite with source "untappd", merged once with derived and manual (no duplicate sources)', async () => {
    const r = await listFavorites(cache, U, { kind: 'brewery' });
    expect(r.map((f) => f.id)).toEqual([1, 3, 2]);
    expect(r[0]).toMatchObject({
      id: 1,
      sources: ['untappd', 'derived', 'manual'],
      reason: 'liked on Untappd (since 2021-03); avg 4 across 5 beers; manual: home team',
    });
    expect(r[2]).toMatchObject({ id: 2, name: 'Liked Only Co.', sources: ['untappd'], reason: 'liked on Untappd (since 2022-05)', liked_at: '2022-05-06T00:00:00.000Z' });
    // Re-syncing the same like twice never duplicates the source.
    await cache.upsertBreweryLikes(U, [like(1, 'Brewery 1')], '2026-11-04T00:00:00.000Z');
    expect((await listFavorites(cache, U, { kind: 'brewery' }))[0].sources).toEqual(['untappd', 'derived', 'manual']);
  });

  it('filters by source "untappd", and beers/venues never carry it', async () => {
    expect((await listFavorites(cache, U, { source: 'untappd' })).map((f) => `${f.kind}:${f.id}`)).toEqual(['brewery:1', 'brewery:2']);
    expect((await listFavorites(cache, U, { source: 'manual' })).map((f) => `${f.kind}:${f.id}`)).toEqual(['brewery:1']);
    expect(await listFavorites(cache, U, { kind: 'venue', source: 'untappd' })).toEqual([]);
  });

  it('favoriteLookup carries the untappd source for liked breweries, alone or merged', async () => {
    const idx = await favoriteLookup(cache, [U], { brewery: [1, 2, 3, 4] });
    expect(idx.get('brewery', 1)).toEqual({
      is_favorite: true,
      sources: ['untappd', 'derived', 'manual'],
      reason: 'liked on Untappd (since 2021-03); avg 4 across 5 beers; manual: home team',
    });
    expect(idx.get('brewery', 2)).toEqual({ is_favorite: true, sources: ['untappd'], reason: 'liked on Untappd (since 2022-05)' });
    expect(idx.get('brewery', 3).sources).toEqual(['derived']);
    expect(idx.get('brewery', 4).is_favorite).toBe(false);
    // A group names who liked it; another user's like counts for the group.
    await cache.upsertBreweryLikes('bob', [like(4, 'Bob Co.', null)], '2026-11-03T00:00:00.000Z');
    const g = await favoriteLookup(cache, [U, 'bob'], { brewery: [4] });
    expect(g.get('brewery', 4)).toEqual({ is_favorite: true, sources: ['untappd'], reason: 'bob: liked on Untappd' });
  });
});
