import { describe, it, expect } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import { mapCheckinRow, type CheckinRow } from '../src/cache/store.js';

function row(id: number, rating: number | null, over: Record<string, unknown> = {}): CheckinRow {
  const r = mapCheckinRow('me', {
    checkin_id: id,
    created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    rating_score: rating,
    beer: { bid: id, beer_name: `Beer ${id}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
    venue: { venue_id: 3, venue_name: 'The Pub' },
    ...over,
  });
  if (!r) throw new Error('fixture did not map');
  return r;
}

describe('cache query sorting', () => {
  it('lowest_rated lists rated check-ins before unrated ones', async () => {
    const cache = CheckinCache.open(':memory:');
    await cache.upsertCheckins('me', [row(1, null), row(2, null), row(3, 2.5), row(4, 4)]);
    const out = await cache.query('me', { sort: 'lowest_rated', limit: 2 });
    expect(out.map((r) => r.rating)).toEqual([2.5, 4]);
    cache.close();
  });

  it('highest_rated also keeps unrated check-ins last', async () => {
    const cache = CheckinCache.open(':memory:');
    await cache.upsertCheckins('me', [row(1, null), row(3, 2.5), row(4, 4)]);
    const out = await cache.query('me', { sort: 'highest_rated' });
    expect(out.map((r) => r.rating)).toEqual([4, 2.5, null]);
    cache.close();
  });
});

describe('cache LIKE filters treat % and _ literally', () => {
  it('matches a brewery name containing % or _ literally, not as a wildcard', async () => {
    const cache = CheckinCache.open(':memory:');
    await cache.upsertCheckins('me', [
      row(1, 4, { brewery: { brewery_id: 1, brewery_name: '100% Brewing' } }),
      row(2, 4, { brewery: { brewery_id: 2, brewery_name: '100 Brewing' } }),
      row(3, 4, { brewery: { brewery_id: 3, brewery_name: 'Snake_Bite Ales' } }),
      row(4, 4, { brewery: { brewery_id: 4, brewery_name: 'SnakeXBite Ales' } }),
    ]);
    expect((await cache.query('me', { brewery: '100%' })).map((r) => r.brewery_id)).toEqual([1]);
    expect((await cache.query('me', { brewery: 'snake_bite' })).map((r) => r.brewery_id)).toEqual([3]);
    cache.close();
  });

  it('has_had by beer name matches a literal underscore', async () => {
    const cache = CheckinCache.open(':memory:');
    await cache.upsertCheckins('me', [
      row(1, 4, { beer: { bid: 1, beer_name: 'Hop_Bomb', beer_style: 'IPA' } }),
      row(2, 4, { beer: { bid: 2, beer_name: 'HopXBomb', beer_style: 'IPA' } }),
    ]);
    const res = await cache.hasHad('me', { beerName: 'hop_bomb' });
    expect(res.count).toBe(1);
    cache.close();
  });
});
