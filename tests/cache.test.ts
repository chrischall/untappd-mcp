import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { McpToolError, RateLimitError } from '@chrischall/mcp-utils';
import { CheckinCache } from '../src/cache/db.js';
import { mapCheckinRow, mapBeerRow, type CacheStore, type CheckinRow, type DistinctBeerRow } from '../src/cache/store.js';
import { syncCheckins } from '../src/cache/sync.js';
import { syncUserBeers } from '../src/cache/sync-beers.js';
import { registerCacheTools } from '../src/tools/cache.js';
import { registerBeerTools } from '../src/tools/beer.js';
import { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';

// ── check-in fixtures (user/checkins) ──
function makeCheckin(id: number, bid = id, over: Record<string, unknown> = {}): unknown {
  return {
    checkin_id: id,
    created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    rating_score: 4,
    beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
    venue: { venue_id: 3, venue_name: 'The Pub' },
    ...over,
  };
}
function makeHistory(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => makeCheckin(n - i)); // ids n..1
}

// ── distinct-beer fixtures (user/beers) ──
function makeBeer(bid: number, over: Record<string, unknown> = {}): unknown {
  return {
    count: 1,
    user_rating_score: 4,
    first_created_at: 'Wed, 10 Feb 2016 12:00:00 +0000',
    recent_created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    first_checkin_id: bid * 10,
    recent_checkin_id: bid * 10 + 1,
    beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
    ...over,
  };
}
function makeBeersList(n: number, startBid = 1000): unknown[] {
  return Array.from({ length: n }, (_, i) => makeBeer(startBid + i));
}

/** Fake client for user/checkins + user/info. `truncated` ignores max_id (non-self behaviour). */
function fakeCheckinsClient(history: unknown[], opts: { total?: number; throwOnCall?: number; truncated?: boolean } = {}) {
  const total = opts.total ?? history.length;
  let calls = 0;
  const ids = history.map((c) => (c as { checkin_id: number }).checkin_id);
  const page = (start: number) => {
    const slice = history.slice(start, start + 50);
    const more = start + 50 < history.length;
    const last = (slice[slice.length - 1] as { checkin_id: number }).checkin_id;
    return { checkins: { items: slice, pagination: { max_id: more ? last : null } } };
  };
  const get = async (path: string, query?: { max_id?: number; offset?: number }) => {
    if (path.startsWith('/user/info/')) return { user: { stats: { total_checkins: total } } };
    if (path.startsWith('/user/checkins/')) {
      calls++;
      if (opts.throwOnCall && calls === opts.throwOnCall) throw new McpToolError('boom');
      if (opts.truncated) {
        // Always return the top 50, ignoring max_id — the cursor never advances.
        const slice = history.slice(0, 50);
        const last = (slice[slice.length - 1] as { checkin_id: number }).checkin_id;
        return { checkins: { items: slice, pagination: { max_id: last } } };
      }
      const maxId = query?.max_id;
      const start = maxId === undefined ? 0 : ids.findIndex((id) => id < maxId);
      return start === -1 ? { checkins: { items: [], pagination: {} } } : page(start);
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { client: { get, get loginName() { return null; } } as unknown as UntappdClient, calls: () => calls };
}

/** Fake client for user/beers (offset paged). */
function fakeBeersClient(beers: unknown[], opts: { total?: number } = {}) {
  const total = opts.total ?? beers.length;
  let calls = 0;
  const get = async (path: string, query?: { offset?: number }) => {
    if (path.startsWith('/user/beers/')) {
      calls++;
      const offset = query?.offset ?? 0;
      const slice = beers.slice(offset, offset + 50);
      return { total_count: total, beers: { count: slice.length, items: slice } };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { client: { get, get loginName() { return null; } } as unknown as UntappdClient, calls: () => calls };
}

async function seedCheckins(cache: CacheStore, username: string, items: unknown[]): Promise<void> {
  const rows = items.map((it) => mapCheckinRow(username, it)).filter((r): r is CheckinRow => r !== null);
  await cache.upsertCheckins(username, rows);
}
async function seedBeers(cache: CacheStore, username: string, items: unknown[]): Promise<void> {
  const rows = items.map((it) => mapBeerRow(username, it)).filter((r): r is DistinctBeerRow => r !== null);
  await cache.upsertDistinctBeers(username, rows);
}

describe('backfill_complete invariant', () => {
  it('never reports complete when the endpoint truncates history (only recent 50 of many)', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeCheckinsClient(makeHistory(200), { total: 12036, truncated: true });
    const summary = await syncCheckins(client, cache, 'mer', 10);
    expect(summary.history_truncated).toBe(true);
    expect(summary.backfill_complete).toBe(false);
    // No point re-running user/checkins — it can't page further.
    expect(summary.another_run_needed).toBe(false);
    expect(summary.note).toContain('untappd_sync_user_beers');
    expect((await cache.getState('mer'))!.backfill_complete).toBe(false);
  });

  it('self-heals a cache wrongly flagged complete on the next sync', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(200);
    // Corrupt prior state (the historical bug): complete, but only 50 of 200 cached.
    await seedCheckins(cache, 'mer', history.slice(0, 50)); // ids 200..151
    await cache.setState('mer', { newest_checkin_id: 200, backfill_complete: true });

    const { client } = fakeCheckinsClient(history, { total: 200 });
    const summary = await syncCheckins(client, cache, 'mer', 10);
    expect(summary.forced).toBe(true); // self-heal reset fired
    expect(summary.backfill_complete).toBe(true);
    expect(await cache.cachedCount('mer')).toBe(200);
  });
});

describe('force_backfill', () => {
  it('resets state, keeps rows, and re-pages the whole history', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(120);
    await seedCheckins(cache, 'mer', history.slice(0, 50));
    await cache.setState('mer', { newest_checkin_id: 120, backfill_complete: true, total_checkins: 120 });

    const { client } = fakeCheckinsClient(history, { total: 120 });
    const summary = await syncCheckins(client, cache, 'mer', { maxPages: 10, force: true });
    expect(summary.forced).toBe(true);
    expect(summary.backfill_complete).toBe(true);
    expect(await cache.cachedCount('mer')).toBe(120); // rows kept + refetched, no loss
  });
});

describe('syncCheckins incremental + resume', () => {
  it('catches up new check-ins without re-paging when within the drift floor', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(240); // ids 240..1
    await seedCheckins(cache, 'mer', history.slice(40)); // ids 200..1 cached
    await cache.setState('mer', { newest_checkin_id: 200, backfill_complete: true, total_checkins: 200 });

    // 200 of 240 = 83% — below the 98% ratio but within the 50-check-in absolute
    // floor, so it must NOT self-heal/re-page; the cheap Phase 1 catch-up handles it.
    const { client, calls } = fakeCheckinsClient(history, { total: 240 });
    const summary = await syncCheckins(client, cache, 'mer', 10);
    expect(summary.forced).toBe(false);
    expect(summary.rows_added).toBe(40); // just the 40 new check-ins (240..201)
    expect(calls()).toBe(1); // one page, stopped at the cached boundary
    expect(summary.backfill_complete).toBe(true);
    expect(await cache.cachedCount('mer')).toBe(240);
  });

  it('Phase 1 catch-up converges (does not loop) on a truncated account gaining >50 new', async () => {
    const cache = CheckinCache.open(':memory:');
    // Prior: known-truncated account, boundary at 6000.
    await seedCheckins(cache, 'mer', [makeCheckin(6000, 6000)]);
    await cache.setState('mer', { newest_checkin_id: 6000, checkins_truncated: true, total_checkins: 12036 });
    // 300 new check-ins on top (6300..6001); the endpoint only ever serves the top 50.
    const newHistory = Array.from({ length: 300 }, (_, i) => makeCheckin(6300 - i, 6300 - i));
    const { client, calls } = fakeCheckinsClient(newHistory, { total: 12036, truncated: true });

    const summary = await syncCheckins(client, cache, 'mer', 10);
    expect(summary.history_truncated).toBe(true);
    expect(summary.another_run_needed).toBe(false); // converged, not stuck in catch-up
    expect(summary.pages_fetched).toBe(2); // stalled on page 2, not looped to maxPages
    // The new top check-ins still landed.
    expect((await cache.hasHad('mer', { bid: 6300 })).had).toBe(true);
  });

  it('persists progress per page and resumes after an interruption', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(120);
    const first = fakeCheckinsClient(history, { total: 120, throwOnCall: 2 });
    await expect(syncCheckins(first.client, cache, 'mer', 10)).rejects.toThrow('boom');
    expect(await cache.cachedCount('mer')).toBe(50); // page 1 persisted before the crash

    const second = fakeCheckinsClient(history, { total: 120 });
    const summary = await syncCheckins(second.client, cache, 'mer', 10);
    expect(await cache.cachedCount('mer')).toBe(120);
    expect(summary.backfill_complete).toBe(true);
    expect(summary.another_run_needed).toBe(false);
  });

  it('reports partial progress when the page budget runs out', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeCheckinsClient(makeHistory(120), { total: 120 });
    const summary = await syncCheckins(client, cache, 'mer', 1);
    expect(summary.pages_fetched).toBe(1);
    expect(summary.backfill_complete).toBe(false);
    expect(summary.another_run_needed).toBe(true);
    expect(summary.backfill_percent).toBe(42); // 50/120
  });

  it('heals a burst of new check-ins bigger than max_pages*50 across repeated runs, without a permanent gap', async () => {
    const cache = CheckinCache.open(':memory:');
    // Fully-backfilled prior cache: ids 1..100.
    const oldHistory = makeHistory(100);
    await seedCheckins(cache, 'mer', oldHistory);
    await cache.setState('mer', { newest_checkin_id: 100, backfill_complete: true, total_checkins: 100 });

    // Burst: 120 NEW check-ins land on top (ids 220..101) — bigger than
    // max_pages(1) * PAGE_LIMIT(50) = 50, so no single run's budget covers it.
    const newTop = Array.from({ length: 120 }, (_, i) => makeCheckin(220 - i, 220 - i));
    const fullHistory = [...newTop, ...oldHistory];
    const { client } = fakeCheckinsClient(fullHistory, { total: 220 });

    let summary = await syncCheckins(client, cache, 'mer', 1);
    let runs = 1;
    // Regression: Phase 1's mandatory "is there anything new?" page used to
    // starve Phase 2 of its entire page budget every run, so the gap below
    // oldest_max_id was NEVER healed no matter how many times sync re-ran.
    while (summary.another_run_needed && runs < 30) {
      summary = await syncCheckins(client, cache, 'mer', 1);
      runs++;
    }

    expect(runs).toBeLessThan(30); // must actually converge, not loop forever
    expect(summary.backfill_complete).toBe(true);
    expect(summary.another_run_needed).toBe(false);
    expect(await cache.cachedCount('mer')).toBe(220);
    // No silent false negatives anywhere in the previously-unreached gap.
    for (const bid of [220, 200, 150, 101]) {
      expect((await cache.hasHad('mer', { bid })).had).toBe(true);
    }
  });
});

describe('syncUserBeers (user/beers offset paging)', () => {
  it('pages the whole distinct-beers list across multiple pages', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeBeersClient(makeBeersList(120));
    const summary = await syncUserBeers(client, cache, 'mer', 10);
    expect(summary.beers_complete).toBe(true);
    expect(summary.cached_distinct_beers).toBe(120);
    expect(summary.total_distinct_beers).toBe(120);
    expect(summary.backfill_percent).toBe(100);
    expect(summary.another_run_needed).toBe(false);
  });

  it('persists completion when the user has no distinct beers (empty first page)', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client, calls } = fakeBeersClient([]);
    const r1 = await syncUserBeers(client, cache, 'mer', 10);
    expect(r1.beers_complete).toBe(true);
    // State was persisted, so a second call doesn't re-run the empty fetch.
    expect((await cache.getState('mer'))!.beers_complete).toBe(true);
    expect(calls()).toBe(1);
    const r2 = await syncUserBeers(client, cache, 'mer', 10);
    expect(r2.another_run_needed).toBe(false);
  });

  it('resumes from the stored offset across runs', async () => {
    const cache = CheckinCache.open(':memory:');
    const beers = makeBeersList(120);
    const { client } = fakeBeersClient(beers);

    const r1 = await syncUserBeers(client, cache, 'mer', 1);
    expect(r1.cached_distinct_beers).toBe(50);
    expect(r1.another_run_needed).toBe(true);
    expect((await cache.getState('mer'))!.beers_offset).toBe(50);

    const r2 = await syncUserBeers(client, cache, 'mer', 1);
    expect(r2.cached_distinct_beers).toBe(100);
    const r3 = await syncUserBeers(client, cache, 'mer', 1);
    expect(r3.cached_distinct_beers).toBe(120);
    expect(r3.beers_complete).toBe(true);
  });
});

describe('has_had consults both sources', () => {
  it('dedupes count across sources and reports which matched', async () => {
    const cache = CheckinCache.open(':memory:');
    // bid 11: one cached check-in AND a distinct-beers row with the true count 5.
    await seedCheckins(cache, 'mer', [makeCheckin(11, 11)]);
    await seedBeers(cache, 'mer', [makeBeer(11, { count: 5 })]);
    // bid 1000: only in the distinct-beers list (count 3); bid 22: only a check-in.
    await seedBeers(cache, 'mer', [makeBeer(1000, { count: 3 })]);
    await seedCheckins(cache, 'mer', [makeCheckin(22, 22)]);

    const both = await cache.hasHad('mer', { bid: 11 });
    expect(both.had).toBe(true);
    expect(both.count).toBe(5); // authoritative user/beers count, not 1 + 5
    expect(both.sources.sort()).toEqual(['beers', 'checkins']);

    const beersOnly = await cache.hasHad('mer', { bid: 1000 });
    expect(beersOnly.had).toBe(true);
    expect(beersOnly.count).toBe(3);
    expect(beersOnly.sources).toEqual(['beers']);
    expect(beersOnly.matches).toEqual([]); // no per-check-in detail from the beers list

    const checkinsOnly = await cache.hasHad('mer', { bid: 22 });
    expect(checkinsOnly.sources).toEqual(['checkins']);

    expect((await cache.hasHad('mer', { bid: 999 })).had).toBe(false);
  });
});

describe('Mer1331-shaped scenario: truncated check-ins, full coverage via user/beers', () => {
  it('has_had_many stops returning false negatives for old beers once user/beers is synced', async () => {
    const cache = CheckinCache.open(':memory:');
    // user/checkins is truncated to the recent 50 (bids 5000..4951); an old beer
    // (bid 1000) is NOT among them, so a checkins-only cache false-negatives it.
    const recent = Array.from({ length: 50 }, (_, i) => makeCheckin(6000 - i, 5000 - i));
    const checkins = fakeCheckinsClient(recent, { total: 12036, truncated: true });
    const checkinsSync = await syncCheckins(checkins.client, cache, 'mer1331', 10);
    expect(checkinsSync.history_truncated).toBe(true);
    expect((await cache.hasHad('mer1331', { bid: 1000 })).had).toBe(false); // the bug: false negative

    // user/beers gives the COMPLETE distinct list (200 beers incl. the old 1000).
    const beers = [makeBeer(1000, { count: 12 }), ...makeBeersList(199, 1001)];
    const beersClient = fakeBeersClient(beers);
    let last = await syncUserBeers(beersClient.client, cache, 'mer1331', 2);
    for (let i = 0; i < 20 && last.another_run_needed; i++) {
      last = await syncUserBeers(beersClient.client, cache, 'mer1331', 2);
    }
    expect(last.beers_complete).toBe(true);
    expect(last.cached_distinct_beers).toBe(200);

    // The old beer is now correctly reported as had, and a menu cross-check is right.
    const old = await cache.hasHad('mer1331', { bid: 1000 });
    expect(old.had).toBe(true);
    expect(old.count).toBe(12);
    expect(old.sources).toEqual(['beers']);
    for (const bid of [1000, 1050, 1199]) expect((await cache.hasHad('mer1331', { bid })).had).toBe(true);
    expect((await cache.hasHad('mer1331', { bid: 424242 })).had).toBe(false);
  });
});

describe('cache tools', () => {
  let cache: CheckinCache;
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await seedBeers(cache, 'mer', [makeBeer(11), makeBeer(22), makeBeer(33)]);
    await cache.setState('mer', { beers_complete: true, beers_total: 3, last_synced_at: '2026-07-11T00:00:00.000Z' });
    harness = await createTestHarness((server) => registerCacheTools(server, new UntappdClient(), () => cache));
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });

  const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  it('has_had_many returns had/not-had per bid, from the beers source', async () => {
    const out = parse(await harness.callTool('untappd_cache_has_had_many', { username: 'mer', bids: [11, 22, 99] }));
    expect(out.had).toBe(2);
    expect(out.not_had).toBe(1);
    const fresh = out.freshness as { coverage_complete: boolean; beers: { complete: boolean } };
    expect(fresh.coverage_complete).toBe(true);
    expect(fresh.beers.complete).toBe(true);
  });

  it('not_had returns only the beers the user has NOT had', async () => {
    const out = parse(await harness.callTool('untappd_cache_not_had', { username: 'mer', bids: [11, 22, 99, 100, 11] }));
    expect(out.checked).toBe(4);
    expect(out.not_had).toEqual([99, 100]);
    expect(out.had).toEqual([11, 22]);
  });

  it('freshness caveats when coverage is incomplete', async () => {
    await cache.setState('mer', { beers_complete: false, beers_total: 100 });
    const out = parse(await harness.callTool('untappd_cache_has_had', { username: 'mer', bid: 11 }));
    const fresh = out.freshness as { coverage_complete: boolean; caveat?: string };
    expect(fresh.coverage_complete).toBe(false);
    expect(fresh.caveat).toContain('untappd_sync_user_beers');
  });

  it('has_had errors when neither bid nor beer_name is given', async () => {
    const r = await harness.callTool('untappd_cache_has_had', { username: 'mer' });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });
});

// ── beer/info fixtures for untappd_top_not_had ──
function makeBeerInfo(
  bid: number,
  over: { style?: string; parent?: string; weighted?: number; rating?: number; name?: string } = {},
): unknown {
  return {
    beer: {
      bid,
      beer_name: over.name ?? `Beer ${bid}`,
      beer_style: over.style ?? 'IPA - Imperial / Double',
      parent_style_name: over.parent ?? 'India Pale Ale (IPA)',
      beer_abv: 8,
      beer_ibu: 100,
      weighted_rating_score: over.weighted ?? 4.2,
      rating_score: over.rating ?? 4.25,
      rating_count: 1000,
      brewery: { brewery_id: 5143, brewery_name: 'Test Brewery' },
    },
  };
}

/** Fake client serving /beer/info/{bid}; optionally rate-limits after N calls. */
function fakeBeerInfoClient(byBid: Record<number, unknown>, opts: { rateLimitAfter?: number } = {}) {
  let calls = 0;
  const get = async (path: string) => {
    const m = path.match(/^\/beer\/info\/(\d+)/);
    if (m) {
      calls++;
      if (opts.rateLimitAfter !== undefined && calls > opts.rateLimitAfter) throw new RateLimitError('Untappd');
      const info = byBid[Number(m[1])];
      if (!info) throw new McpToolError('beer not found');
      return info;
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { client: { get, get loginName() { return null; } } as unknown as UntappdClient, calls: () => calls };
}

describe('untappd_top_not_had', () => {
  const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  async function harnessWith(cache: CheckinCache, client: UntappdClient) {
    return createTestHarness((server) => registerCacheTools(server, client, () => cache));
  }

  it('cache-hit path makes ZERO API calls and ranks by weighted rating', async () => {
    const cache = CheckinCache.open(':memory:');
    // Pre-seed fresh metadata for three not-had candidates.
    const nowIso = new Date().toISOString();
    await cache.upsertBeerMeta([
      mapMeta(701, { weighted: 4.1, nowIso }),
      mapMeta(702, { weighted: 4.7, nowIso }),
      mapMeta(703, { weighted: 4.4, nowIso }),
    ]);
    const { client, calls } = fakeBeerInfoClient({});
    const h = await harnessWith(cache, client);
    try {
      const out = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [701, 702, 703], top_n: 2 }));
      expect(calls()).toBe(0); // everything was cached
      expect(out.summary.api_calls_used).toBe(0);
      expect((out.ranked as Array<{ bid: number }>).map((r) => r.bid)).toEqual([702, 703]); // top 2 by weighted
      expect(out.summary.partial).toBe(false);
      expect(out.freshness).toBeDefined();
    } finally {
      await h.close();
    }
  });

  it('cold cache respects api_budget and resumes on a second run', async () => {
    const cache = CheckinCache.open(':memory:');
    const byBid = {
      801: makeBeerInfo(801, { weighted: 4.0 }),
      802: makeBeerInfo(802, { weighted: 4.9 }),
      803: makeBeerInfo(803, { weighted: 4.5 }),
      804: makeBeerInfo(804, { weighted: 4.3 }),
    };
    const { client, calls } = fakeBeerInfoClient(byBid);
    const h = await harnessWith(cache, client);
    try {
      const r1 = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [801, 802, 803, 804], top_n: 2, api_budget: 2 }));
      expect(r1.summary.api_calls_used).toBe(2);
      expect(r1.summary.partial).toBe(true);
      expect(r1.summary.another_run_needed).toBe(true);
      expect(calls()).toBe(2);

      // Second run: the first two are now cached, the remaining two are fetched.
      const r2 = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [801, 802, 803, 804], top_n: 2, api_budget: 2 }));
      expect(r2.summary.api_calls_used).toBe(2); // only the two uncached ones
      expect(r2.summary.partial).toBe(false);
      expect((r2.ranked as Array<{ bid: number }>).map((r) => r.bid)).toEqual([802, 803]); // best two overall
    } finally {
      await h.close();
    }
  });

  it('degrades to partial (not failure) on a rate-limit error mid-run', async () => {
    const cache = CheckinCache.open(':memory:');
    const byBid = {
      850: makeBeerInfo(850, { weighted: 4.5 }),
      851: makeBeerInfo(851, { weighted: 4.6 }),
      852: makeBeerInfo(852, { weighted: 4.7 }),
    };
    // Budget is generous, but the API rate-limits after the first call.
    const { client, calls } = fakeBeerInfoClient(byBid, { rateLimitAfter: 1 });
    const h = await harnessWith(cache, client);
    try {
      const out = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [850, 851, 852], top_n: 5, api_budget: 25 }));
      expect(out.summary.api_calls_used).toBe(2); // requests sent: one success + the 429
      expect(out.summary.partial).toBe(true);
      expect(out.summary.another_run_needed).toBe(true);
      expect(out.summary.rate_limited).toBe(true);
      expect(out.summary.errors).toBe(0); // a rate limit isn't a per-bid error
      expect((out.ranked as Array<{ bid: number }>).length).toBe(1); // ranks what it got, no throw
      expect(calls()).toBe(2); // one success + the one that threw
    } finally {
      await h.close();
    }
  });

  it('surfaces errors > 0 (not an empty success) when beer/info fails for every bid', async () => {
    const cache = CheckinCache.open(':memory:');
    // A cold cache where every beer/info fails (e.g. an outage) must be
    // distinguishable from "the cache says all candidates were already had".
    const { client } = fakeBeerInfoClient({}); // no bids known → every fetch throws
    const h = await harnessWith(cache, client);
    try {
      const out = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [111, 222, 333] }));
      expect(out.summary.not_had).toBe(3);
      expect(out.summary.api_calls_used).toBe(3);
      expect(out.summary.errors).toBe(3);
      expect(out.ranked).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('style filter matches on the PARENT style, not just the beer style', async () => {
    const cache = CheckinCache.open(':memory:');
    const nowIso = new Date().toISOString();
    await cache.upsertBeerMeta([
      // beer_style has no "ipa", but the parent style does.
      mapMeta(901, { weighted: 4.6, style: 'Hazy Pale', parent: 'India Pale Ale (IPA)', nowIso }),
      mapMeta(902, { weighted: 4.8, style: 'Stout - Imperial', parent: 'Stouts', nowIso }),
    ]);
    const { client } = fakeBeerInfoClient({});
    const h = await harnessWith(cache, client);
    try {
      const out = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [901, 902], style: 'ipa', top_n: 5 }));
      expect(out.summary.style_matched).toBe(1);
      expect((out.ranked as Array<{ bid: number }>).map((r) => r.bid)).toEqual([901]); // the stout is filtered out
    } finally {
      await h.close();
    }
  });

  it('returns nothing when every candidate has already been had', async () => {
    const cache = CheckinCache.open(':memory:');
    await seedBeers(cache, 'mer', [makeBeer(1001), makeBeer(1002)]);
    const { client, calls } = fakeBeerInfoClient({});
    const h = await harnessWith(cache, client);
    try {
      const out = parse(await h.callTool('untappd_top_not_had', { username: 'mer', bids: [1001, 1002, 1001] }));
      expect(out.summary.candidates).toBe(2); // deduped
      expect(out.summary.not_had).toBe(0);
      expect(out.ranked).toEqual([]);
      expect(calls()).toBe(0);
    } finally {
      await h.close();
    }
  });
});

function mapMeta(
  bid: number,
  o: { weighted?: number; style?: string; parent?: string; nowIso: string },
) {
  return {
    bid,
    name: `Beer ${bid}`,
    brewery: 'Test Brewery',
    brewery_id: 5143,
    style: o.style ?? 'IPA - Imperial / Double',
    parent_style: o.parent ?? 'India Pale Ale (IPA)',
    abv: 8,
    ibu: 100,
    weighted_rating_score: o.weighted ?? 4.2,
    rating_score: 4.25,
    rating_count: 1000,
    fetched_at: o.nowIso,
  };
}

describe('opportunistic beer_meta seeding', () => {
  it('untappd_beer_info seeds the metadata cache', async () => {
    const cache = CheckinCache.open(':memory:');
    const { client } = fakeBeerInfoClient({ 4499: makeBeerInfo(4499, { name: 'Pliny', weighted: 4.49 }) });
    const h = await createTestHarness((server) => registerBeerTools(server, client, () => cache));
    try {
      await h.callTool('untappd_beer_info', { bid: 4499 });
      const meta = await cache.getBeerMeta([4499]);
      expect(meta.length).toBe(1);
      expect(meta[0].name).toBe('Pliny');
      expect(meta[0].weighted_rating_score).toBeCloseTo(4.49);
    } finally {
      await h.close();
    }
  });

  it('untappd_search_beer seeds metadata from result items', async () => {
    const cache = CheckinCache.open(':memory:');
    const searchData = {
      beers: {
        items: [
          { beer: { bid: 555, beer_name: 'X', beer_style: 'IPA', rating_score: 4.1, rating_count: 10 }, brewery: { brewery_id: 1, brewery_name: 'B' } },
        ],
      },
    };
    const client = { get: async () => searchData, get loginName() { return null; } } as unknown as UntappdClient;
    const h = await createTestHarness((server) => registerBeerTools(server, client, () => cache));
    try {
      await h.callTool('untappd_search_beer', { query: 'x' });
      const meta = await cache.getBeerMeta([555]);
      expect(meta.length).toBe(1);
      expect(meta[0].rating_score).toBeCloseTo(4.1);
      expect(meta[0].brewery).toBe('B');
    } finally {
      await h.close();
    }
  });
});
