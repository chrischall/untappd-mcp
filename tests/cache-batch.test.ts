import { describe, it, expect } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import type { CheckinRow, DistinctBeerRow } from '../src/cache/store.js';

const checkin = (id: number, bid: number, over: Partial<CheckinRow> = {}): CheckinRow => ({
  checkin_id: id, username: 'mer', bid, beer_name: `Beer ${bid}`, brewery_id: 1, brewery_name: 'X',
  beer_style: 'IPA', abv: 6, rating: 3.5, comment: null, venue_id: null, venue_name: null,
  created_at: '2025-01-01T00:00:00.000Z', ...over,
});
const beer = (bid: number, over: Partial<DistinctBeerRow> = {}): DistinctBeerRow => ({
  username: 'mer', bid, beer_name: `Beer ${bid}`, brewery_id: 1, brewery_name: 'X', beer_style: 'IPA', abv: 6,
  rating: 4, had_count: 2, first_had: '2020-01-01T00:00:00.000Z', last_had: '2024-06-01T00:00:00.000Z', ...over,
});

describe('hasHadMany', () => {
  it('gives exactly the per-bid hasHad verdict for every bid, across both sources', async () => {
    const cache = CheckinCache.open(':memory:');
    // 10: check-ins only. 20: distinct-beers only. 30: both (had_count wins, max date/rating).
    // 40: distinct-beers with a null had_count. 50: unknown.
    await cache.upsertCheckins('mer', [
      checkin(1, 10), checkin(2, 10, { rating: 4.25, created_at: '2025-03-01T00:00:00.000Z' }),
      checkin(3, 30, { rating: 4.75, created_at: '2025-05-01T00:00:00.000Z' }),
    ]);
    await cache.upsertDistinctBeers('mer', [beer(20), beer(30, { had_count: 7 }), beer(40, { had_count: null, rating: null })]);
    const many = await cache.hasHadMany('Mer', [10, 20, 30, 40, 50, 10]);
    expect([...many.keys()]).toEqual([10, 20, 30, 40, 50]);
    for (const bid of [10, 20, 30, 40, 50]) {
      const { matches: _m, ...single } = await cache.hasHad('mer', { bid });
      expect(many.get(bid)).toEqual(single);
    }
    expect(many.get(30)).toMatchObject({ count: 7, best_rating: 4.75, last_date: '2025-05-01T00:00:00.000Z', sources: ['checkins', 'beers'] });
  });

  it('handles more bids than one IN-list chunk', async () => {
    const cache = CheckinCache.open(':memory:');
    await cache.upsertDistinctBeers('mer', Array.from({ length: 1200 }, (_, i) => beer(i + 1)));
    const many = await cache.hasHadMany('mer', Array.from({ length: 1300 }, (_, i) => i + 1));
    expect([...many.values()].filter((v) => v.had)).toHaveLength(1200);
  });
});

describe('upsert net-new counts (no whole-table COUNT)', () => {
  it('counts only ids new to this user, deduping within the batch', async () => {
    const cache = CheckinCache.open(':memory:');
    expect(await cache.upsertDistinctBeers('mer', [beer(1), beer(2), beer(2)])).toBe(2);
    expect(await cache.upsertDistinctBeers('mer', [beer(2), beer(3)])).toBe(1);
    expect(await cache.upsertDistinctBeers('other', [beer(2, { username: 'other' })])).toBe(1); // per-user
    expect(await cache.upsertCheckins('mer', [checkin(1, 1), checkin(2, 1), checkin(2, 1)])).toBe(2);
    expect(await cache.upsertCheckins('mer', [checkin(2, 1), checkin(3, 1)])).toBe(1);
    expect(await cache.distinctBeersCount('mer')).toBe(3);
    expect(await cache.cachedCount('mer')).toBe(3);
  });
});
