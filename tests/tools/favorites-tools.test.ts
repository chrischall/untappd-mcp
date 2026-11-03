import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UntappdClient } from '../../src/client.js';
import { CheckinCache } from '../../src/cache/db.js';
import type { BeerMeta, DistinctBeerRow, UserVenueItem } from '../../src/cache/store.js';
import { registerBreweryTools } from '../../src/tools/brewery.js';
import { registerVenueTools } from '../../src/tools/venue.js';
import { registerCacheTools } from '../../src/tools/cache.js';
import { registerFavoriteTools } from '../../src/tools/favorites.js';
import { createTestHarness } from '../helpers.js';

const client = new UntappdClient();
const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);
const write = vi.spyOn(client, 'write').mockResolvedValue(undefined as never);
let cache: CheckinCache;
let harness: Awaited<ReturnType<typeof createTestHarness>>;
const U = 'mer';
const parse = (r: unknown): Record<string, any> => JSON.parse((r as { content: { text: string }[] }).content[0].text);

function distinct(bid: number, o: Partial<DistinctBeerRow> = {}): DistinctBeerRow {
  return {
    username: U, bid, beer_name: `Beer ${bid}`, brewery_id: 1, brewery_name: 'Brew One', beer_style: 'IPA', abv: 6,
    rating: null, had_count: 1, first_had: '2020-01-01T00:00:00.000Z', last_had: '2020-01-01T00:00:00.000Z', ...o,
  };
}
function venue(id: number, count: number, name: string): UserVenueItem {
  return {
    venue: { venue_id: id, name, category: 'Brewery', address: null, city: 'Tampa', state: 'FL', country: 'US', lat: 27.95, lng: -82.43, is_verified: 1 },
    visit: { venue_id: id, first_visit: '2016-02-10T12:00:00.000Z', first_checkin_id: 1, recent_visit: '2025-07-05T18:00:00.000Z', recent_checkin_id: 2, total_count: count },
  };
}
function meta(bid: number, rating: number, breweryId: number): BeerMeta {
  return {
    bid, name: `New ${bid}`, brewery: `Brewery ${breweryId}`, brewery_id: breweryId, style: 'IPA', parent_style: 'IPA', abv: 6, ibu: null,
    weighted_rating_score: rating, rating_score: rating, rating_count: 100, fetched_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  get.mockReset();
  get.mockResolvedValue(undefined as never);
  cache = CheckinCache.open(':memory:');
  // Brewery 1 is a derived favorite (5 beers, avg 4.0); beer 1 is rated 4.5 → derived favorite beer.
  await cache.upsertDistinctBeers(U, [1, 2, 3, 4, 5].map((b) => distinct(b, { rating: b === 1 ? 4.5 : 3.875 })));
  await cache.setState(U, { beers_complete: true, beers_total: 5, last_synced_at: '2026-11-01T00:00:00.000Z' });
  await cache.upsertUserVenues(U, [venue(100, 12, 'Coppertail Brewing Co.'), venue(101, 1, 'Coppertail Brewing Co. (duplicate of 1005)')]);
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('favorite tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerBreweryTools(server, client, () => cache);
      registerVenueTools(server, client, () => cache);
      registerCacheTools(server, client, () => cache);
      registerFavoriteTools(server, client, () => cache);
    });
  });

  it('favorite_add / favorites_list / favorite_remove are local only', async () => {
    const a = parse(await harness.callTool('untappd_favorite_add', { username: U, kind: 'venue', id: 101, note: 'patio' }));
    expect(a).toMatchObject({ added: true, username: U, kind: 'venue', id: 101, note: 'patio', name: 'Coppertail Brewing Co. (duplicate of 1005)' });
    await harness.callTool('untappd_favorite_add', { username: U, kind: 'beer', id: 1 });

    const all = parse(await harness.callTool('untappd_favorites_list', { username: U }));
    const key = (f: any) => `${f.kind}:${f.id}`;
    expect(all.favorites.map(key)).toEqual(['venue:100', 'venue:101', 'brewery:1', 'beer:1']);
    expect(all.favorites.find((f: any) => key(f) === 'beer:1')).toMatchObject({ sources: ['derived', 'manual'], reason: 'rated 4.5; added manually' });
    expect(all.counts).toEqual({ venue: 2, brewery: 1, beer: 1 });
    expect(all.thresholds.venue_min_checkins).toBe(5);

    const manualVenues = parse(await harness.callTool('untappd_favorites_list', { username: U, kind: 'venue', source: 'manual' }));
    expect(manualVenues.favorites.map(key)).toEqual(['venue:101']);

    // Thresholds are parameters.
    const strict = parse(await harness.callTool('untappd_favorites_list', { username: U, kind: 'brewery', thresholds: { brewery_min_avg_rating: 4.5 } }));
    expect(strict.favorites).toEqual([]);

    const r = parse(await harness.callTool('untappd_favorite_remove', { username: U, kind: 'venue', id: 101 }));
    expect(r).toMatchObject({ removed: true });
    expect(parse(await harness.callTool('untappd_favorite_remove', { username: U, kind: 'venue', id: 101 })).removed).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('cache_has_had carries a favorite field', async () => {
    const yes = parse(await harness.callTool('untappd_cache_has_had', { username: U, bid: 1 }));
    expect(yes.favorite).toEqual({ is_favorite: true, sources: ['derived'], reason: 'rated 4.5' });
    const no = parse(await harness.callTool('untappd_cache_has_had', { username: U, bid: 2 }));
    expect(no.favorite).toEqual({ is_favorite: false, sources: [], reason: null });
  });

  it('cache_has_visited marks each matched venue', async () => {
    await cache.addFavorite(U, 'venue', 101, null, '2026-01-01T00:00:00.000Z');
    const r = parse(await harness.callTool('untappd_cache_has_visited', { username: U, queries: [{ name: 'Coppertail' }] }));
    const byId = Object.fromEntries(r.results[0].matches.map((m: any) => [m.venue_id, m.favorite]));
    expect(byId[100]).toEqual({ is_favorite: true, sources: ['derived'], reason: '12 check-ins since 2016' });
    expect(byId[101]).toEqual({ is_favorite: true, sources: ['manual'], reason: 'added manually' });
  });

  it('brewery_beers marks the brewery and favorite beers', async () => {
    get.mockResolvedValue({
      total_count: 2,
      beers: {
        count: 2,
        items: [
          { total_count: 9, beer: { bid: 1, beer_name: 'Beer 1', beer_style: 'IPA', beer_abv: 6, rating_score: 4, rating_count: 9, is_in_production: 1 }, brewery: { brewery_id: 1, brewery_name: 'Brew One' } },
          { total_count: 9, beer: { bid: 9, beer_name: 'Beer 9', beer_style: 'IPA', beer_abv: 6, rating_score: 4, rating_count: 9, is_in_production: 1 }, brewery: { brewery_id: 1, brewery_name: 'Brew One' } },
        ],
      },
    } as never);
    const r = parse(await harness.callTool('untappd_brewery_beers', { brewery_id: 1, username: U }));
    expect(r.favorite).toEqual({ is_favorite: true, sources: ['derived'], reason: 'avg 4 across 5 beers' });
    expect(r.beers.items[0].favorite).toEqual({ is_favorite: true, sources: ['derived'], reason: 'rated 4.5' });
    expect(r.beers.items[1].favorite).toBeUndefined();
  });

  it('venue_menu marks the venue, favorite beers and favorite breweries — also on a cache hit', async () => {
    get.mockResolvedValue({
      venue: {
        verfied_beers: {
          total_count: 2,
          items: [{ menu: { menu_id: 1, menu_name: 'Taps', total_item_count: 2, sections: { items: [{ section_id: 1, section_name: 'Drafts', items: [
            { beer: { bid: 1, beer_name: 'Beer 1' }, brewery: { brewery_id: 1, brewery_name: 'Brew One' } },
            { beer: { bid: 50, beer_name: 'Other' }, brewery: { brewery_id: 77, brewery_name: 'Other Co' } },
          ] }] } } }],
        },
      },
    } as never);
    const a = parse(await harness.callTool('untappd_venue_menu', { venue_id: 100, username: U }));
    expect(a.favorite).toMatchObject({ is_favorite: true, sources: ['derived'] });
    expect(a.beers[0]).toMatchObject({ bid: 1, brewery_id: 1, favorite: { is_favorite: true, reason: 'rated 4.5' }, brewery_favorite: { is_favorite: true } });
    expect(a.beers[1].favorite).toBeUndefined();
    expect(a.beers[1].brewery_favorite).toBeUndefined();

    // Favorites are applied on read, so a change shows even on a cached menu.
    await cache.addFavorite(U, 'brewery', 77, 'friends', '2026-01-01T00:00:00.000Z');
    const b = parse(await harness.callTool('untappd_venue_menu', { venue_id: 100, username: U }));
    expect(b.cache.hit).toBe(true);
    expect(b.beers[1].brewery_favorite).toEqual({ is_favorite: true, sources: ['manual'], reason: 'manual: friends' });
  });

  describe('top_not_had prefer_favorites boost', () => {
    beforeEach(async () => {
      // Not-had candidates: 20 (rating 4.4, brewery 99), 21 (4.2, favorite brewery 1), 22 (4.0, wishlisted).
      await cache.upsertBeerMeta([meta(20, 4.4, 99), meta(21, 4.2, 1), meta(22, 4.0, 98)]);
      await cache.upsertWishlist(U, [{ bid: 22, beer_name: 'New 22', brewery_id: 98, brewery_name: 'B', style: 'IPA', abv: 6, added_at: null }], '2026-11-01T00:00:00.000Z');
    });

    it('ranks favorite-brewery and wishlisted beers higher by default, and explains why', async () => {
      const r = parse(await harness.callTool('untappd_top_not_had', { username: U, bids: [20, 21, 22], top_n: 3 }));
      expect(r.ranked.map((b: any) => b.bid)).toEqual([22, 21, 20]);
      expect(r.ranked[0]).toMatchObject({ bid: 22, rating: 4.0, wishlisted: true, boosted_by: ['wishlist'] });
      expect(r.ranked[1]).toMatchObject({ bid: 21, rating: 4.2, boosted_by: ['favorite_brewery'], brewery_favorite: { is_favorite: true, sources: ['derived'] } });
      expect(r.ranked[2].boosted_by).toBeUndefined();
      expect(r.ranked[0].score).toBeGreaterThan(r.ranked[1].score);
      expect(r.summary.prefer_favorites).toBe(true);
    });

    it('prefer_favorites:false ranks by rating alone', async () => {
      const r = parse(await harness.callTool('untappd_top_not_had', { username: U, bids: [20, 21, 22], top_n: 3, prefer_favorites: false }));
      expect(r.ranked.map((b: any) => b.bid)).toEqual([20, 21, 22]);
      expect(r.ranked[0].boosted_by).toBeUndefined();
      expect(r.summary.prefer_favorites).toBe(false);
    });

    it('a boost never beats a much better beer', async () => {
      await cache.upsertBeerMeta([meta(23, 4.8, 99)]);
      const r = parse(await harness.callTool('untappd_top_not_had', { username: U, bids: [20, 21, 22, 23], top_n: 4 }));
      expect(r.ranked[0].bid).toBe(23);
    });
  });
});
