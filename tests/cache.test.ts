import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import { CheckinCache, mapCheckinRow, type CheckinRow } from '../src/cache/db.js';
import { syncCheckins } from '../src/cache/sync.js';
import { registerCacheTools } from '../src/tools/cache.js';
import { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';

// A raw `/user/checkins` list item, shaped like the fields the mapper reads.
function makeCheckin(id: number, bid = id, over: Record<string, unknown> = {}): unknown {
  return {
    checkin_id: id,
    created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    rating_score: 4,
    checkin_comment: '',
    beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
    venue: { venue_id: 3, venue_name: 'The Pub' },
    user: { user_name: 'mer1331' },
    ...over,
  };
}

/** History newest-first: ids n..1, bid === id for easy assertions. */
function makeHistory(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => makeCheckin(n - i));
}

/**
 * Fake UntappdClient that paginates a fixed history backwards (50/page) via
 * `max_id` — the older-than cursor. `throwOnCall` makes the Nth `/user/checkins`
 * fetch throw, simulating a mid-sync interruption (rate limit / crash).
 */
function fakeClient(history: unknown[], opts: { total?: number; throwOnCall?: number } = {}) {
  const total = opts.total ?? history.length;
  let checkinCalls = 0;
  const ids = history.map((c) => (c as { checkin_id: number }).checkin_id);
  const get = async (path: string, query?: { max_id?: number }) => {
    if (path.startsWith('/user/info/')) return { user: { stats: { total_checkins: total } } };
    if (path.startsWith('/user/checkins/')) {
      checkinCalls++;
      if (opts.throwOnCall && checkinCalls === opts.throwOnCall) throw new McpToolError('boom');
      const maxId = query?.max_id;
      const start = maxId === undefined ? 0 : ids.findIndex((id) => id < maxId);
      if (start === -1) return { checkins: { items: [], pagination: {} } };
      const slice = history.slice(start, start + 50);
      const more = start + 50 < history.length;
      const last = (slice[slice.length - 1] as { checkin_id: number }).checkin_id;
      return { checkins: { items: slice, pagination: { max_id: more ? last : null } } };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return {
    client: { get, get loginName() { return null; } } as unknown as UntappdClient,
    checkinCalls: () => checkinCalls,
  };
}

function seed(cache: CheckinCache, username: string, items: unknown[]): void {
  const rows = items.map((it) => mapCheckinRow(username, it)).filter((r): r is CheckinRow => r !== null);
  cache.upsertCheckins(username, rows);
}

describe('CheckinCache upsert/dedupe', () => {
  it('dedupes on checkin_id and reports only net-new rows', () => {
    const cache = CheckinCache.open(':memory:');
    const first = cache.upsertCheckins('u', [mapCheckinRow('u', makeCheckin(5, 5, { rating_score: 3 }))!]);
    expect(first).toBe(1);
    expect(cache.cachedCount('u')).toBe(1);

    // Re-upsert the SAME checkin_id with a changed rating: 0 net-new, updated in place.
    const again = cache.upsertCheckins('u', [mapCheckinRow('u', makeCheckin(5, 5, { rating_score: 4.5 }))!]);
    expect(again).toBe(0);
    expect(cache.cachedCount('u')).toBe(1);
    const row = cache.query('u', {})[0];
    expect(row.rating).toBe(4.5);
  });

  it('keys usernames case-insensitively', () => {
    const cache = CheckinCache.open(':memory:');
    cache.upsertCheckins('Mer1331', [mapCheckinRow('Mer1331', makeCheckin(9))!]);
    expect(cache.cachedCount('mer1331')).toBe(1);
    expect(cache.hasHad('MER1331', { bid: 9 }).had).toBe(true);
  });
});

describe('syncCheckins incremental', () => {
  it('stops as soon as it reaches already-cached check-ins', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(200); // ids 200..1
    // Pretend a prior sync cached ids 150..1 and finished its backfill.
    seed(cache, 'mer', history.slice(50));
    cache.setState('mer', { newest_checkin_id: 150, backfill_complete: true, oldest_max_id: null });

    const { client, checkinCalls } = fakeClient(history, { total: 200 });
    const summary = await syncCheckins(client, cache, 'mer', 10);

    // Only the 50 genuinely new check-ins (200..151) are added, and it stops on
    // page 2 the moment it crosses the 150 boundary — it does NOT page to the end.
    expect(summary.rows_added).toBe(50);
    expect(summary.pages_fetched).toBe(2);
    expect(checkinCalls()).toBe(2);
    expect(summary.backfill_complete).toBe(true);
    expect(summary.another_run_needed).toBe(false);
    expect(cache.cachedCount('mer')).toBe(200);
  });
});

describe('syncCheckins backfill resume after interruption', () => {
  it('persists progress per page and resumes without losing or duplicating data', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(120); // ids 120..1

    // First run interrupts on the 2nd page fetch.
    const first = fakeClient(history, { total: 120, throwOnCall: 2 });
    await expect(syncCheckins(first.client, cache, 'mer', 10)).rejects.toThrow('boom');

    // Page 1 was persisted before the crash: 50 rows + a resume cursor.
    expect(cache.cachedCount('mer')).toBe(50);
    const mid = cache.getState('mer')!;
    expect(mid.oldest_max_id).toBe(71); // last id on page 1 (120..71)
    expect(mid.backfill_complete).toBe(false);
    expect(mid.newest_checkin_id).toBe(120);

    // Second run (no interruption) resumes from the cursor and finishes.
    const second = fakeClient(history, { total: 120 });
    const summary = await syncCheckins(second.client, cache, 'mer', 10);

    expect(cache.cachedCount('mer')).toBe(120); // complete, no duplicates
    expect(summary.backfill_complete).toBe(true);
    expect(summary.another_run_needed).toBe(false);
    expect(summary.backfill_percent).toBe(100);
    // The resume cursor is cleared once the backfill reaches the end.
    expect(cache.getState('mer')!.oldest_max_id).toBeNull();
  });

  it('reports partial progress and that another run is needed when budget runs out', async () => {
    const cache = CheckinCache.open(':memory:');
    const history = makeHistory(120);
    const { client } = fakeClient(history, { total: 120 });

    const summary = await syncCheckins(client, cache, 'mer', 1); // only one page
    expect(summary.pages_fetched).toBe(1);
    expect(cache.cachedCount('mer')).toBe(50);
    expect(summary.backfill_complete).toBe(false);
    expect(summary.another_run_needed).toBe(true);
    expect(summary.backfill_percent).toBe(42); // 50/120
  });
});

describe('cache tools', () => {
  let cache: CheckinCache;
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    seed(cache, 'mer', [makeCheckin(11, 11), makeCheckin(22, 22), makeCheckin(33, 33)]);
    cache.setState('mer', { backfill_complete: true, last_synced_at: '2026-07-11T00:00:00.000Z', total_checkins: 3 });
    harness = await createTestHarness((server) => registerCacheTools(server, new UntappdClient(), () => cache));
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });

  function parse(r: unknown): Record<string, unknown> {
    return JSON.parse((r as { content: { text: string }[] }).content[0].text);
  }

  it('has_had_many returns had/not-had per bid in one call', async () => {
    const r = await harness.callTool('untappd_cache_has_had_many', { username: 'mer', bids: [11, 22, 99] });
    const out = parse(r);
    expect(out.checked).toBe(3);
    expect(out.had).toBe(2);
    expect(out.not_had).toBe(1);
    const results = out.results as Array<{ bid: number; had: boolean; count: number }>;
    expect(results).toEqual([
      { bid: 11, had: true, count: 1, last_date: expect.any(String), best_rating: 4 },
      { bid: 22, had: true, count: 1, last_date: expect.any(String), best_rating: 4 },
      { bid: 99, had: false, count: 0, last_date: null, best_rating: null },
    ]);
    expect((out.freshness as { backfill_complete: boolean }).backfill_complete).toBe(true);
  });

  it('has_had matches by bid and reports freshness', async () => {
    const out = parse(await harness.callTool('untappd_cache_has_had', { username: 'mer', bid: 22 }));
    expect(out.had).toBe(true);
    expect(out.count).toBe(1);
    expect((out.freshness as { cached_checkins: number }).cached_checkins).toBe(3);
  });

  it('has_had errors when neither bid nor beer_name is given', async () => {
    const r = await harness.callTool('untappd_cache_has_had', { username: 'mer' });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it('query filters by style and returns a caveat when backfill is incomplete', async () => {
    cache.setState('mer', { backfill_complete: false, total_checkins: 100 });
    const out = parse(await harness.callTool('untappd_cache_query', { username: 'mer', style: 'ipa' }));
    expect(out.count).toBe(3);
    expect((out.freshness as { caveat?: string }).caveat).toContain('Backfill is incomplete');
  });
});
