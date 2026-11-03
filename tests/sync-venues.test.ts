import { describe, it, expect } from 'vitest';
import { RateLimitError } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../src/client.js';
import { CheckinCache } from '../src/cache/db.js';
import { mapUserVenueItem } from '../src/cache/store.js';
import { syncUserVenues, VENUES_PAGE_REQUEST, VENUES_RESUME_OVERLAP } from '../src/cache/sync-venues.js';
import type { ApiCallObservation } from '../src/ratelimit.js';

// One user/venues item, shaped like the live v4 response (see the plan's Background).
export function venueItem(id: number, over: Record<string, unknown> = {}, venueOver: Record<string, unknown> = {}) {
  return {
    venue: {
      venue_id: id,
      venue_name: `Venue ${id}`,
      primary_category: 'Bar',
      categories: { count: 1, items: [{ category_name: 'Bar' }] },
      location: {
        venue_address: `${id} Main St`,
        venue_city: 'Tampa',
        venue_state: 'FL',
        venue_country: 'United States',
        lat: 27.9 + id / 10_000,
        lng: -82.4,
      },
      is_verified: true,
      ...venueOver,
    },
    first_visit: 'Wed, 10 Feb 2016 12:00:00 +0000',
    first_checkin_id: id * 10,
    recent_visit: 'Sat, 05 Jul 2025 18:23:11 +0000',
    recent_checkin_id: id * 10 + 1,
    total_count: 1,
    ...over,
  };
}

/**
 * A user/venues route over a list of items that — like the live API — returns
 * at most 25 per page whatever `limit` asks for, and reports the NEXT offset in
 * pagination.offset.
 */
function venuesRoute(getItems: () => unknown[], perPage = 25) {
  return (_p: string, q: Record<string, unknown>) => {
    const items = getItems();
    const offset = Number(q.offset ?? 0);
    const page = items.slice(offset, offset + perPage);
    return {
      total_count: items.length,
      venues: { count: page.length, items: page },
      pagination: { next_url: '', offset: offset + page.length },
    };
  };
}

function fakeClient(opts: {
  spent?: number;
  route: (path: string, q: Record<string, unknown>) => unknown;
  fail?: (n: number) => boolean;
}) {
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
      return opts.route(path, q);
    },
  } as unknown as UntappdClient;
  return { client, calls };
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe('mapUserVenueItem', () => {
  it('maps the venue facts and the per-user visit summary, normalising dates to ISO', () => {
    const m = mapUserVenueItem('Mer', venueItem(42, { total_count: 7 }));
    expect(m).not.toBeNull();
    expect(m!.venue).toMatchObject({
      venue_id: 42, name: 'Venue 42', category: 'Bar', address: '42 Main St', city: 'Tampa', state: 'FL',
      country: 'United States', lat: 27.9042, lng: -82.4, is_verified: 1,
    });
    expect(m!.visit).toMatchObject({
      venue_id: 42, first_visit: '2016-02-10T12:00:00.000Z', first_checkin_id: 420,
      recent_visit: '2025-07-05T18:23:11.000Z', recent_checkin_id: 421, total_count: 7,
    });
  });

  it('skips an item without a venue id, and tolerates a missing location', () => {
    expect(mapUserVenueItem('mer', { venue: [] })).toBeNull();
    const m = mapUserVenueItem('mer', { venue: { venue_id: 5, venue_name: 'Home' } });
    expect(m!.venue).toMatchObject({ venue_id: 5, city: null, lat: null });
  });
});

describe('syncUserVenues backfill', () => {
  it('advances by the returned pagination.offset: 25 per page even though it asks for 50', async () => {
    const cache = CheckinCache.open(':memory:');
    const items = range(1, 120).map((id) => venueItem(id));
    const { client, calls } = fakeClient({ route: venuesRoute(() => items) });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    expect(calls.map((c) => c.q.offset)).toEqual([0, 25, 50, 75, 100]);
    expect(calls.every((c) => c.q.limit === VENUES_PAGE_REQUEST && VENUES_PAGE_REQUEST === 50)).toBe(true);
    expect(calls.every((c) => c.q.sort === 'date')).toBe(true);
    expect(calls[0].path).toBe('/user/venues/mer');
    // A 25-item page is NOT a short final page — it paged all 120.
    expect(s).toMatchObject({
      pages_fetched: 5, cached_venues: 120, total_venues: 120, backfill_percent: 100,
      venues_complete: true, another_run_needed: false, incremental: false, venues_added: 120,
    });
    cache.close();
  });

  it('falls back to offset + items when pagination.offset is absent', async () => {
    const cache = CheckinCache.open(':memory:');
    const items = range(1, 60).map((id) => venueItem(id));
    const route = (_p: string, q: Record<string, unknown>) => {
      const o = Number(q.offset ?? 0);
      const page = items.slice(o, o + 25);
      return { total_count: items.length, venues: { count: page.length, items: page } };
    };
    const { client, calls } = fakeClient({ route });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    expect(calls.map((c) => c.q.offset)).toEqual([0, 25, 50]);
    expect(s.venues_complete).toBe(true);
    cache.close();
  });

  it('persists the cursor after every page and resumes there (less a small overlap) on the next run', async () => {
    const cache = CheckinCache.open(':memory:');
    const items = range(1, 200).map((id) => venueItem(id));
    const first = fakeClient({ route: venuesRoute(() => items) });
    const s1 = await syncUserVenues(first.client, cache, 'mer', 3);
    expect(s1).toMatchObject({
      pages_fetched: 3, cached_venues: 75, total_venues: 200, backfill_percent: 38,
      venues_complete: false, another_run_needed: true,
    });
    expect(s1.note).toMatch(/untappd_sync_user_venues/);
    expect(await cache.getListState('mer', 'venues')).toMatchObject({ next_offset: 75, total_count: 200, complete: false });

    const second = fakeClient({ route: venuesRoute(() => items) });
    const s2 = await syncUserVenues(second.client, cache, 'MER', 50);
    expect(second.calls[0].q.offset).toBe(75 - VENUES_RESUME_OVERLAP);
    expect(s2).toMatchObject({ cached_venues: 200, venues_complete: true, another_run_needed: false });
    cache.close();
  });

  it('stops before the rate limit with resume info and the cursor saved', async () => {
    const cache = CheckinCache.open(':memory:');
    const items = range(1, 200).map((id) => venueItem(id));
    // 96 spent: est 4 → two pages allowed, the third refused.
    const { client, calls } = fakeClient({ spent: 96, route: venuesRoute(() => items) });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    expect(calls).toHaveLength(2);
    expect(s).toMatchObject({ pages_fetched: 2, cached_venues: 50, stopped_for_rate_limit: true, another_run_needed: true });
    expect(s.rate_limit?.resume_at).toEqual(expect.any(String));
    expect(s.note).toMatch(/run untappd_sync_user_venues again after/);
    expect((await cache.getListState('mer', 'venues'))?.next_offset).toBe(50);
    cache.close();
  });

  it('turns a 429 mid-batch into a clean stop', async () => {
    const cache = CheckinCache.open(':memory:');
    const items = range(1, 200).map((id) => venueItem(id));
    const { client } = fakeClient({ route: venuesRoute(() => items), fail: (n) => n === 3 });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    expect(s).toMatchObject({ pages_fetched: 2, cached_venues: 50, stopped_for_rate_limit: true });
    expect(s.rate_limit).toMatchObject({ resume_after_s: 600 });
    cache.close();
  });

  it('explains a private/unreachable account on the first page', async () => {
    const cache = CheckinCache.open(':memory:');
    const client = {
      async get() {
        throw new Error('HTTP 500');
      },
    } as unknown as UntappdClient;
    await expect(syncUserVenues(client, cache, 'mer', 1)).rejects.toThrow(/venue history for "mer"/);
    cache.close();
  });
});

describe('syncUserVenues incremental refresh', () => {
  async function completeCache(items: unknown[]) {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeClient({ route: venuesRoute(() => items) });
    const s = await syncUserVenues(client, cache, 'mer', 50);
    expect(s.venues_complete).toBe(true);
    return cache;
  }

  it('pages sort=date from offset 0 and stops at the first page where every recent_visit is unchanged', async () => {
    // 100 venues, newest first. Then three are re-visited (move to the top with a
    // new recent_visit) and two brand-new venues appear.
    let items = range(1, 100).map((id) => venueItem(id));
    const cache = await completeCache(items);
    const revisited = [40, 70, 90].map((id) =>
      venueItem(id, { recent_visit: 'Mon, 02 Nov 2026 20:00:00 +0000', total_count: 2 }),
    );
    const fresh = [501, 502].map((id) => venueItem(id, { recent_visit: 'Mon, 02 Nov 2026 21:00:00 +0000' }));
    const rest = items.filter((it) => ![40, 70, 90].includes((it as { venue: { venue_id: number } }).venue.venue_id));
    items = [...fresh, ...revisited, ...rest]; // 102 items
    const { client, calls } = fakeClient({ route: venuesRoute(() => items) });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    // Page 1 (offset 0) holds the 5 changed + 20 unchanged → keep going;
    // page 2 (offset 25) is entirely unchanged → stop.
    expect(calls.map((c) => c.q.offset)).toEqual([0, 25]);
    expect(calls.every((c) => c.q.sort === 'date')).toBe(true);
    expect(s).toMatchObject({
      incremental: true, venues_complete: true, another_run_needed: false, venues_added: 2,
      venues_updated: 3, cached_venues: 102, total_venues: 102,
    });
    const v = await cache.findVisitedVenues('mer', { venue_ids: [40] });
    expect(v[0]).toMatchObject({ total_count: 2, recent_visit: '2026-11-02T20:00:00.000Z' });
    cache.close();
  });

  it('an unchanged list costs exactly one page', async () => {
    const items = range(1, 80).map((id) => venueItem(id));
    const cache = await completeCache(items);
    const { client, calls } = fakeClient({ route: venuesRoute(() => items) });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    expect(calls).toHaveLength(1);
    expect(s).toMatchObject({ incremental: true, venues_added: 0, venues_updated: 0, venues_complete: true });
    cache.close();
  });

  it('a page with one changed venue is not a stop page even when the rest are unchanged', async () => {
    let items = range(1, 75).map((id) => venueItem(id));
    const cache = await completeCache(items);
    // Venue 30 (on page 2) re-visited but NOT moved — e.g. a same-day re-check-in.
    items = items.map((it) =>
      (it as { venue: { venue_id: number } }).venue.venue_id === 30
        ? venueItem(30, { recent_visit: 'Mon, 02 Nov 2026 20:00:00 +0000', total_count: 3 })
        : it,
    );
    const { client, calls } = fakeClient({ route: venuesRoute(() => items) });
    const s = await syncUserVenues(client, cache, 'mer', 10);
    // Page 1 unchanged → stop immediately. (Sorted by recency, a venue below an
    // unchanged page can't have changed in a real list; this pins the rule.)
    expect(calls.map((c) => c.q.offset)).toEqual([0]);
    expect(s.venues_updated).toBe(0);
    // With the change on page 1 instead, the walk continues to page 2.
    items = range(1, 75).map((id) =>
      id === 3 ? venueItem(3, { recent_visit: 'Mon, 02 Nov 2026 20:00:00 +0000' }) : venueItem(id),
    );
    const again = fakeClient({ route: venuesRoute(() => items) });
    const s2 = await syncUserVenues(again.client, cache, 'mer', 10);
    expect(again.calls.map((c) => c.q.offset)).toEqual([0, 25]);
    expect(s2.venues_updated).toBe(1);
    cache.close();
  });
});

describe('syncUserVenues interrupted incremental refresh', () => {
  const NEW_VISIT = 'Mon, 02 Nov 2026 20:00:00 +0000';
  const vid = (it: unknown) => (it as { venue: { venue_id: number } }).venue.venue_id;

  // 100 venues fully cached; then 40 of them re-visited and 10 brand-new venues
  // appear — 50 changed venues, i.e. two full pages of changes at the top.
  async function changedHistory() {
    const cache = CheckinCache.open(':memory:');
    const before = range(1, 100).map((id) => venueItem(id));
    const seed = fakeClient({ route: venuesRoute(() => before) });
    expect((await syncUserVenues(seed.client, cache, 'mer', 50)).venues_complete).toBe(true);
    const revisitedIds = range(30, 40); // 30..69
    const fresh = range(901, 10).map((id) => venueItem(id, { recent_visit: NEW_VISIT }));
    const revisited = revisitedIds.map((id) => venueItem(id, { recent_visit: NEW_VISIT, total_count: 2 }));
    const rest = before.filter((it) => !revisitedIds.includes(vid(it)));
    return { cache, items: [...fresh, ...revisited, ...rest], revisitedIds };
  }

  async function expectAllChangesCached(cache: CheckinCache, revisitedIds: number[]) {
    const fresh = await cache.findVisitedVenues('mer', { venue_ids: range(901, 10) });
    expect(fresh).toHaveLength(10);
    const rev = await cache.findVisitedVenues('mer', { venue_ids: revisitedIds });
    expect(rev).toHaveLength(revisitedIds.length);
    expect(rev.every((r) => r.total_count === 2 && r.recent_visit === '2026-11-02T20:00:00.000Z')).toBe(true);
  }

  it('cut short by max_pages: reports unfinished, then resumes the refresh instead of restarting at 0', async () => {
    const { cache, items, revisitedIds } = await changedHistory();

    const first = fakeClient({ route: venuesRoute(() => items) });
    const s1 = await syncUserVenues(first.client, cache, 'mer', 1);
    expect(first.calls.map((c) => c.q.offset)).toEqual([0]);
    expect(s1).toMatchObject({ incremental: true, venues_complete: false, another_run_needed: true });
    expect(s1.note).toMatch(/refresh/i);
    // While the refresh is unfinished the history is not authoritative.
    expect((await cache.stats()).users[0].venues).toMatchObject({ complete: false, refresh_in_progress: true });

    const second = fakeClient({ route: venuesRoute(() => items) });
    const s2 = await syncUserVenues(second.client, cache, 'mer', 10);
    // Resumes at the refresh cursor (less the overlap), reaches the stop page.
    expect(second.calls[0].q.offset).toBe(25 - VENUES_RESUME_OVERLAP);
    // Changes occupy positions 0-49, so page 45 (45-69) still holds 5; page 70 is the stop page.
    expect(second.calls.map((c) => c.q.offset)).toEqual([20, 45, 70]);
    expect(s2).toMatchObject({ incremental: true, venues_complete: true, another_run_needed: false, cached_venues: 110 });
    await expectAllChangesCached(cache, revisitedIds);
    expect((await cache.stats()).users[0].venues).toMatchObject({ complete: true, refresh_in_progress: false });

    // A finished refresh restarts at 0 next time: an unchanged list costs one page.
    const third = fakeClient({ route: venuesRoute(() => items) });
    const s3 = await syncUserVenues(third.client, cache, 'mer', 10);
    expect(third.calls.map((c) => c.q.offset)).toEqual([0]);
    expect(s3).toMatchObject({ venues_complete: true, another_run_needed: false, venues_added: 0, venues_updated: 0 });
    cache.close();
  });

  it('cut short by a 429: the next run picks up every changed and new venue', async () => {
    const { cache, items, revisitedIds } = await changedHistory();
    const first = fakeClient({ route: venuesRoute(() => items), fail: (n) => n === 2 });
    const s1 = await syncUserVenues(first.client, cache, 'mer', 10);
    expect(s1).toMatchObject({ pages_fetched: 1, stopped_for_rate_limit: true, venues_complete: false, another_run_needed: true });

    const second = fakeClient({ route: venuesRoute(() => items) });
    const s2 = await syncUserVenues(second.client, cache, 'mer', 10);
    expect(second.calls[0].q.offset).toBe(20);
    expect(s2).toMatchObject({ venues_complete: true, another_run_needed: false });
    await expectAllChangesCached(cache, revisitedIds);
    cache.close();
  });

  it('cut short by the pre-emptive rate stop: the next run picks up every changed and new venue', async () => {
    const { cache, items, revisitedIds } = await changedHistory();
    // 97 spent: est 3 → exactly one page allowed.
    const first = fakeClient({ spent: 97, route: venuesRoute(() => items) });
    const s1 = await syncUserVenues(first.client, cache, 'mer', 10);
    expect(first.calls).toHaveLength(1);
    expect(s1).toMatchObject({ stopped_for_rate_limit: true, venues_complete: false, another_run_needed: true });
    expect(s1.note).toMatch(/untappd_sync_user_venues again after/);

    const second = fakeClient({ route: venuesRoute(() => items) });
    await syncUserVenues(second.client, cache, 'mer', 10);
    await expectAllChangesCached(cache, revisitedIds);
    cache.close();
  });

  it('more changes than max_pages*25 are all picked up across runs', async () => {
    const cache = CheckinCache.open(':memory:');
    const before = range(1, 150).map((id) => venueItem(id));
    await syncUserVenues(fakeClient({ route: venuesRoute(() => before) }).client, cache, 'mer', 50);
    const revisitedIds = range(20, 100); // 4 pages of changes
    const revisited = revisitedIds.map((id) => venueItem(id, { recent_visit: NEW_VISIT, total_count: 2 }));
    const items = [...revisited, ...before.filter((it) => !revisitedIds.includes(vid(it)))];
    let runs = 0;
    let s;
    do {
      s = await syncUserVenues(fakeClient({ route: venuesRoute(() => items) }).client, cache, 'mer', 1);
      runs++;
    } while (s.another_run_needed && runs < 10);
    expect(s.another_run_needed).toBe(false);
    const rev = await cache.findVisitedVenues('mer', { venue_ids: revisitedIds });
    expect(rev.every((r) => r.total_count === 2)).toBe(true);
    expect(rev).toHaveLength(100);
    cache.close();
  });
});

describe('venue coverage in cache stats', () => {
  it('reports cached/total venues, completeness and the cursor per user', async () => {
    const cache = CheckinCache.open(':memory:');
    const items = range(1, 60).map((id) => venueItem(id));
    const { client } = fakeClient({ route: venuesRoute(() => items) });
    await syncUserVenues(client, cache, 'mer', 1);
    const stats = await cache.stats();
    expect(stats.venue_entries).toBe(25);
    expect(stats.users).toEqual([
      expect.objectContaining({
        username: 'mer',
        venues: expect.objectContaining({ cached_venues: 25, total_venues: 60, complete: false, next_offset: 25, percent: 42 }),
      }),
    ]);
    cache.close();
  });
});
