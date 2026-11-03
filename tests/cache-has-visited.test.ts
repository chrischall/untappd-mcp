import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import { mapUserVenueItem } from '../src/cache/store.js';
import { registerCacheTools } from '../src/tools/cache.js';
import { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';

type Loc = { city?: string; state?: string; lat?: number; lng?: number };
function item(id: number, name: string, loc: Loc, visits: { first?: string; recent?: string; count?: number } = {}) {
  return {
    venue: {
      venue_id: id,
      venue_name: name,
      primary_category: 'Brewery',
      location: {
        venue_address: '',
        venue_city: loc.city ?? 'Tampa',
        venue_state: loc.state ?? 'FL',
        venue_country: 'United States',
        lat: loc.lat ?? 0,
        lng: loc.lng ?? 0,
      },
      is_verified: false,
    },
    first_visit: visits.first ?? 'Wed, 10 Feb 2016 12:00:00 +0000',
    first_checkin_id: id * 10,
    recent_visit: visits.recent ?? 'Sat, 05 Jul 2025 18:23:11 +0000',
    recent_checkin_id: id * 10 + 1,
    total_count: visits.count ?? 1,
  };
}

// A Tampa-area visit history, incl. Untappd's duplicate-venue naming.
const HISTORY = [
  item(100, 'Coppertail Brewing Co.', { lat: 27.9568, lng: -82.4329 }, { count: 6 }),
  item(101, 'Coppertail Brewing Co. (duplicate of 1005)', { lat: 27.9569, lng: -82.433 }, { count: 2, recent: 'Fri, 01 Mar 2019 12:00:00 +0000' }),
  item(200, 'Green Bench Brewing Co.', { city: 'St. Petersburg', lat: 27.7731, lng: -82.6457 }, { count: 3 }),
  item(201, 'Green Bench Brewing - Tampa', { city: 'Tampa', lat: 27.96, lng: -82.46 }),
  item(300, 'Cigar City Brewing', { lat: 27.9596, lng: -82.5068 }, { count: 9 }),
  item(301, 'Cigar City Brewpub - TPA Airport', { lat: 27.9799, lng: -82.5347 }),
  item(400, '100% Pure Bar', { lat: 10, lng: 10 }),
];

describe('findVisitedVenues (store)', () => {
  let cache: CheckinCache;
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    const mapped = HISTORY.map((h) => mapUserVenueItem('mer', h)!);
    await cache.upsertUserVenues('mer', mapped);
  });

  it('matches exact venue ids', async () => {
    const r = await cache.findVisitedVenues('MER', { venue_ids: [300, 999] });
    expect(r.map((v) => v.venue_id)).toEqual([300]);
    expect(r[0]).toMatchObject({ name: 'Cigar City Brewing', total_count: 9, first_visit: '2016-02-10T12:00:00.000Z' });
  });

  it('name is a case-insensitive substring, and catches duplicate venues', async () => {
    const r = await cache.findVisitedVenues('mer', { name: 'coppertail' });
    expect(r.map((v) => v.venue_id).sort()).toEqual([100, 101]);
    expect(r.find((v) => v.venue_id === 101)?.is_duplicate).toBe(true);
    expect(r.find((v) => v.venue_id === 100)?.is_duplicate).toBe(false);
  });

  it('name tokens match across punctuation and missing words ("Green Bench Brewing" vs "Green Bench Brewing Co.")', async () => {
    const r = await cache.findVisitedVenues('mer', { name: 'Green Bench Brewing Company' });
    // "Company" isn't in either name: tokens must all appear, except corporate suffixes.
    expect(r.map((v) => v.venue_id).sort()).toEqual([200, 201]);
  });

  it('city/state narrow a name match', async () => {
    const stp = await cache.findVisitedVenues('mer', { name: 'green bench', city: 'st. pete' });
    expect(stp.map((v) => v.venue_id)).toEqual([200]);
    const tpa = await cache.findVisitedVenues('mer', { name: 'green bench', city: 'tampa', state: 'fl' });
    expect(tpa.map((v) => v.venue_id)).toEqual([201]);
  });

  it('treats LIKE wildcards in the name literally', async () => {
    expect((await cache.findVisitedVenues('mer', { name: '100%' })).map((v) => v.venue_id)).toEqual([400]);
    expect(await cache.findVisitedVenues('mer', { name: '_igar' })).toEqual([]);
  });

  it('geo matches within radius_m and reports the distance', async () => {
    // ~15 m from Coppertail: both it and its duplicate (~13 m further) are within 150 m.
    const r = await cache.findVisitedVenues('mer', { lat: 27.9567, lng: -82.4328 });
    expect(r.map((v) => v.venue_id).sort()).toEqual([100, 101]);
    for (const v of r) expect(v.distance_m).toBeLessThan(150);
    // A tight radius keeps only the nearer one.
    const tight = await cache.findVisitedVenues('mer', { lat: 27.9567, lng: -82.4328, radius_m: 20 });
    expect(tight.map((v) => v.venue_id)).toEqual([100]);
    // Far from everything → nothing.
    expect(await cache.findVisitedVenues('mer', { lat: 40, lng: -74 })).toEqual([]);
  });

  it('name AND geo together must both hold', async () => {
    const r = await cache.findVisitedVenues('mer', { name: 'cigar city', lat: 27.9799, lng: -82.5347, radius_m: 500 });
    expect(r.map((v) => v.venue_id)).toEqual([301]);
  });

  it('another user sees none of it', async () => {
    expect(await cache.findVisitedVenues('someoneelse', { name: 'coppertail' })).toEqual([]);
  });
});

describe('untappd_cache_has_visited (tool)', () => {
  let cache: CheckinCache;
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await cache.upsertUserVenues('mer', HISTORY.map((h) => mapUserVenueItem('mer', h)!));
    await cache.setListState('mer', 'venues', {
      next_offset: 7, total_count: 7, complete: true, last_synced_at: '2026-11-02T00:00:00.000Z',
    });
    if (harness) await harness.close();
    harness = await createTestHarness((server) => registerCacheTools(server, new UntappdClient(), () => cache));
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('answers a batch of queries in one call, with visit dates and freshness', async () => {
    const out = parse(
      await harness.callTool('untappd_cache_has_visited', {
        username: 'mer',
        queries: [
          { label: 'Coppertail', name: 'Coppertail Brewing', city: 'Tampa' },
          { label: 'CCB any Tampa', name: 'cigar city', city: 'tampa' },
          { label: 'by id', venue_ids: [200] },
          { label: 'Ulele', name: 'Ulele', city: 'Tampa' },
          { label: 'near Coppertail', lat: 27.9567, lng: -82.4328 },
        ],
      }),
    );
    expect(out.username).toBe('mer');
    const [copper, ccb, byId, ulele, near] = out.results;
    expect(copper).toMatchObject({ label: 'Coppertail', visited: true, match_count: 2, total_visits: 8 });
    // Most-visited first; dates carried through.
    expect(copper.matches[0]).toMatchObject({
      venue_id: 100, total_count: 6, first_visit: '2016-02-10T12:00:00.000Z', recent_visit: '2025-07-05T18:23:11.000Z',
    });
    expect(copper.matches[1]).toMatchObject({ venue_id: 101, is_duplicate: true });
    expect(ccb.matches.map((m: { venue_id: number }) => m.venue_id).sort()).toEqual([300, 301]);
    expect(byId).toMatchObject({ visited: true, match_count: 1 });
    expect(ulele).toMatchObject({ visited: false, match_count: 0, matches: [] });
    expect(near.matches[0].distance_m).toEqual(expect.any(Number));
    expect(out.visited_count).toBe(4);
    expect(out.freshness).toMatchObject({
      last_synced_at: '2026-11-02T00:00:00.000Z', coverage_complete: true, cached_venues: 7, total_venues: 7, percent: 100,
    });
    expect(out.freshness.caveat).toBeUndefined();
  });

  it('caveats a not-visited when the venue history is incomplete or never synced', async () => {
    await cache.setListState('mer', 'venues', { complete: false, total_count: 2000, next_offset: 7 });
    const out = parse(await harness.callTool('untappd_cache_has_visited', { username: 'mer', queries: [{ name: 'Ulele' }] }));
    expect(out.freshness.coverage_complete).toBe(false);
    expect(out.freshness.caveat).toMatch(/false negative/);
    expect(out.freshness.caveat).toMatch(/untappd_sync_user_venues/);

    const never = parse(await harness.callTool('untappd_cache_has_visited', { username: 'nobody', queries: [{ name: 'x' }] }));
    expect(never.freshness.caveat).toMatch(/never been synced/);
  });

  it('rejects a query with no criteria, and lat without lng', async () => {
    const empty = await harness.callTool('untappd_cache_has_visited', { username: 'mer', queries: [{ label: 'nothing' }] });
    expect((empty as { isError?: boolean }).isError).toBe(true);
    const half = await harness.callTool('untappd_cache_has_visited', { username: 'mer', queries: [{ lat: 27.9 }] });
    expect((half as { isError?: boolean }).isError).toBe(true);
  });

  it('makes no API call', async () => {
    // new UntappdClient() has no credentials — any network attempt would throw.
    const out = parse(await harness.callTool('untappd_cache_has_visited', { username: 'mer', queries: [{ venue_ids: [100] }] }));
    expect(out.results[0].visited).toBe(true);
  });
});
