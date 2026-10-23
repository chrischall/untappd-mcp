import { describe, it, expect } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import { syncUserBeers } from '../src/cache/sync-beers.js';
import type { UntappdClient } from '../src/client.js';

// The incremental refresh of a COMPLETE distinct-beers cache: user/beers is
// sorted by each beer's most recent check-in, so paging can stop at the first
// beer whose cached copy is unchanged.

const day = (n: number) => new Date(Date.UTC(2024, 0, 1) + n * 86_400_000).toUTCString();
const item = (bid: number, lastDay: number, count = 1) => ({
  count,
  recent_created_at: day(lastDay),
  first_created_at: day(0),
  beer: { bid, beer_name: `Beer ${bid}` },
  brewery: { brewery_id: 1, brewery_name: 'X' },
});

function listClient(list: () => unknown[]) {
  const offsets: number[] = [];
  const get = async (_path: string, q: { offset?: number } = {}) => {
    const all = list();
    const offset = q.offset ?? 0;
    offsets.push(offset);
    return { total_count: all.length, beers: { items: all.slice(offset, offset + 50) } };
  };
  return { client: { get } as unknown as UntappdClient, offsets };
}

describe('incremental user/beers sync', () => {
  it('stops at the first already-cached, unchanged beer instead of paging the whole list', async () => {
    const cache = CheckinCache.open(':memory:');
    // 300 beers, newest-had first (bid 1300 last had on day 300 … bid 1001 on day 1).
    let list = Array.from({ length: 300 }, (_, i) => item(1300 - i, 300 - i));
    const { client, offsets } = listClient(() => list);
    const first = await syncUserBeers(client, cache, 'mer', 50);
    expect(first).toMatchObject({ beers_complete: true, cached_distinct_beers: 300, pages_fetched: 6 });

    // 60 new beers had since: they sit on top of the date-sorted list.
    list = [...Array.from({ length: 60 }, (_, i) => item(5060 - i, 400 - i)), ...list];
    offsets.length = 0;
    const inc = await syncUserBeers(client, cache, 'mer', 50);
    expect(inc).toMatchObject({ incremental: true, beers_added: 60, cached_distinct_beers: 360, beers_complete: true, stopped_at_bid: 1300 });
    // Page 1 = 50 new; page 2 = 10 new, then bid 1300 is cached and unchanged → stop.
    // Without the early stop this would page all 8 pages.
    expect(offsets).toEqual([0, 50]);
  });

  it('a cached beer that was RE-HAD does not stop the walk — a new beer below it is still picked up', async () => {
    const cache = CheckinCache.open(':memory:');
    let list = Array.from({ length: 120 }, (_, i) => item(2120 - i, 120 - i));
    const { client, offsets } = listClient(() => list);
    await syncUserBeers(client, cache, 'mer', 50);

    // bid 2005 was re-had today (moves to the top with a new date/count), and a
    // brand-new beer 7777 was had yesterday, so it sits BELOW the re-had one.
    const rehad = item(2005, 500, 2);
    list = [rehad, item(7777, 499), ...list.filter((b) => b.beer.bid !== 2005)];
    offsets.length = 0;
    const inc = await syncUserBeers(client, cache, 'mer', 50);
    expect(inc).toMatchObject({ beers_added: 1, stopped_at_bid: 2120 });
    expect(offsets).toEqual([0]);
    expect((await cache.hasHad('mer', { bid: 7777 })).had).toBe(true);
    expect((await cache.hasHad('mer', { bid: 2005 })).count).toBe(2); // the re-had count was updated
  });
});
