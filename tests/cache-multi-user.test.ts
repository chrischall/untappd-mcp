import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import { mapBeerRow, type BeerMeta, type DistinctBeerRow } from '../src/cache/store.js';
import { multiHasHad, resolveUsers } from '../src/cache/multi-user.js';
import { registerCacheTools } from '../src/tools/cache.js';
import type { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';

function beer(bid: number, count = 1): unknown {
  return {
    count,
    user_rating_score: 4,
    first_created_at: 'Wed, 10 Feb 2016 12:00:00 +0000',
    recent_created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
  };
}
async function seed(cache: CheckinCache, user: string, bids: number[], complete = true): Promise<void> {
  const rows = bids.map((b) => mapBeerRow(user, beer(b, 2))).filter((r): r is DistinctBeerRow => r !== null);
  await cache.upsertDistinctBeers(user, rows);
  await cache.setState(user, { beers_complete: complete, beers_total: complete ? bids.length : bids.length + 100, last_synced_at: '2026-11-01T00:00:00.000Z' });
}
function meta(bid: number, weighted: number): BeerMeta {
  return {
    bid, name: `Beer ${bid}`, brewery: 'B', brewery_id: 1, style: 'IPA', parent_style: 'IPA', abv: 6, ibu: null,
    weighted_rating_score: weighted, rating_score: weighted, rating_count: 10, fetched_at: new Date().toISOString(),
  };
}
const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

// alice had 1,2 ; bob had 2,3 ; candidates 1..4
//   none_had    → 4            (nobody had it)
//   any_not_had → 1, 3, 4      (at least one of them hasn't); 2 is had by both
describe('multiHasHad', () => {
  let cache: CheckinCache;
  beforeEach(async () => {
    cache = CheckinCache.open(':memory:');
    await seed(cache, 'alice', [1, 2]);
    await seed(cache, 'bob', [2, 3]);
  });

  it('none_had keeps only beers new to EVERYONE', async () => {
    const v = await multiHasHad(cache, ['alice', 'bob'], [1, 2, 3, 4], 'none_had');
    expect([...v.values()].filter((x) => x.qualifies).map((x) => x.bid)).toEqual([4]);
    expect(v.get(2)!.had_by.map((h) => h.username)).toEqual(['alice', 'bob']);
    expect(v.get(2)!.not_had_by).toEqual([]);
    expect(v.get(1)!.not_had_by).toEqual(['bob']);
    expect(v.get(1)!.had_by[0]).toMatchObject({ username: 'alice', count: 2 });
  });

  it('any_not_had keeps beers at least one user has not had', async () => {
    const v = await multiHasHad(cache, ['alice', 'bob'], [1, 2, 3, 4], 'any_not_had');
    expect([...v.values()].filter((x) => x.qualifies).map((x) => x.bid)).toEqual([1, 3, 4]);
  });

  it('dedupes candidate bids and keeps input order', async () => {
    const v = await multiHasHad(cache, ['alice'], [4, 1, 4], 'none_had');
    expect([...v.keys()]).toEqual([4, 1]);
  });
});

describe('resolveUsers', () => {
  it('defaults to username, else the login', () => {
    expect(resolveUsers('mer', undefined, 'me')).toEqual(['mer']);
    expect(resolveUsers(undefined, undefined, 'me')).toEqual(['me']);
  });
  it('dedupes usernames case-insensitively, keeping the first spelling', () => {
    expect(resolveUsers(undefined, ['Alice', 'bob', 'ALICE'], null)).toEqual(['Alice', 'bob']);
  });
  it('rejects username and usernames together', () => {
    expect(() => resolveUsers('mer', ['bob'], null)).toThrow(/username.*usernames|usernames.*username/i);
  });
});

describe('multi-user cache tools', () => {
  let cache: CheckinCache;
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  let apiCalls = 0;
  const client = {
    get loginName() { return null; },
    async get() { apiCalls++; throw new Error('no network in tests'); },
  } as unknown as UntappdClient;

  beforeEach(async () => {
    apiCalls = 0;
    cache = CheckinCache.open(':memory:');
    await seed(cache, 'alice', [1, 2]);
    await seed(cache, 'bob', [2, 3]);
    h = await createTestHarness((server) => registerCacheTools(server, client, () => cache));
  });
  afterEach(async () => {
    await h.close();
  });

  it('has_had_many with usernames + none_had (the default mode)', async () => {
    const out = parse(await h.callTool('untappd_cache_has_had_many', { usernames: ['alice', 'bob'], bids: [1, 2, 3, 4] }));
    expect(out.usernames).toEqual(['alice', 'bob']);
    expect(out.mode).toBe('none_had');
    expect(out.qualifying).toBe(1);
    expect(out.qualifying_bids).toEqual([4]);
    const r2 = out.results.find((r: { bid: number }) => r.bid === 2);
    expect(r2).toMatchObject({ qualifies: false, not_had_by: [] });
    expect(r2.had_by.map((x: { username: string }) => x.username)).toEqual(['alice', 'bob']);
    expect(out.freshness.coverage_complete).toBe(true);
    expect(Object.keys(out.freshness.by_user)).toEqual(['alice', 'bob']);
    expect(apiCalls).toBe(0);
  });

  it('has_had_many any_not_had, and a per-user caveat when one user is incomplete', async () => {
    await cache.setState('bob', { beers_complete: false, beers_total: 500 });
    const out = parse(await h.callTool('untappd_cache_has_had_many', { usernames: ['alice', 'bob'], bids: [1, 2, 3, 4], mode: 'any_not_had' }));
    expect(out.qualifying_bids).toEqual([1, 3, 4]);
    expect(out.freshness.coverage_complete).toBe(false);
    expect(out.freshness.caveat).toContain('bob');
    expect(out.freshness.caveat).not.toContain('alice');
  });

  it('has_had_many keeps its single-user shape when usernames is omitted', async () => {
    const out = parse(await h.callTool('untappd_cache_has_had_many', { username: 'alice', bids: [1, 4] }));
    expect(out).toMatchObject({ username: 'alice', checked: 2, had: 1, not_had: 1 });
    expect(out.usernames).toBeUndefined();
  });

  it('has_had_many rejects username together with usernames', async () => {
    const r = await h.callTool('untappd_cache_has_had_many', { username: 'alice', usernames: ['bob'], bids: [1] });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it('top_not_had none_had ranks only beers new to the whole group', async () => {
    await cache.upsertBeerMeta([meta(1, 4.9), meta(2, 4.8), meta(3, 4.7), meta(4, 3.5)]);
    const out = parse(await h.callTool('untappd_top_not_had', { usernames: ['alice', 'bob'], bids: [1, 2, 3, 4], top_n: 5 }));
    expect(out.usernames).toEqual(['alice', 'bob']);
    expect(out.ranked.map((r: { bid: number }) => r.bid)).toEqual([4]);
    expect(out.summary).toMatchObject({ mode: 'none_had', candidates: 4, not_had: 1, api_calls_used: 0 });
    expect(apiCalls).toBe(0);
  });

  it('top_not_had any_not_had ranks beers someone still needs, saying who', async () => {
    await cache.upsertBeerMeta([meta(1, 4.9), meta(2, 4.8), meta(3, 4.7), meta(4, 3.5)]);
    const out = parse(await h.callTool('untappd_top_not_had', { usernames: ['alice', 'bob'], bids: [1, 2, 3, 4], top_n: 5, mode: 'any_not_had' }));
    expect(out.ranked.map((r: { bid: number }) => r.bid)).toEqual([1, 3, 4]); // 2 is had by both
    expect(out.ranked[0]).toMatchObject({ bid: 1, not_had_by: ['bob'], had_by: ['alice'] });
    expect(out.ranked[2]).toMatchObject({ bid: 4, not_had_by: ['alice', 'bob'], had_by: [] });
    expect(out.freshness.by_user).toBeDefined();
  });
});
