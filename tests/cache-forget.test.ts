import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';
import { mapBeerRow, mapCheckinRow, type CheckinRow, type DistinctBeerRow } from '../src/cache/store.js';
import { registerCacheTools } from '../src/tools/cache.js';
import { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';

// Synthetic fixtures only — no real usernames, venues or comments.
function checkin(id: number): unknown {
  return {
    checkin_id: id,
    created_at: 'Sat, 05 Jul 2025 18:23:11 +0000',
    rating_score: 4,
    checkin_comment: 'test comment',
    beer: { bid: id, beer_name: `Beer ${id}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
    venue: { venue_id: 3, venue_name: 'Test Venue' },
  };
}
function beer(bid: number): unknown {
  return {
    count: 1,
    user_rating_score: 4,
    beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
  };
}
async function seed(cache: CheckinCache, username: string, n: number): Promise<void> {
  const cs = Array.from({ length: n }, (_, i) => mapCheckinRow(username, checkin(username.length * 1000 + i + 1)));
  await cache.upsertCheckins(username, cs.filter((r): r is CheckinRow => r !== null));
  const bs = Array.from({ length: n }, (_, i) => mapBeerRow(username, beer(i + 1)));
  await cache.upsertDistinctBeers(username, bs.filter((r): r is DistinctBeerRow => r !== null));
  await cache.setState(username, { last_synced_at: '2026-01-01T00:00:00.000Z', beers_complete: true });
}

describe('forgetUser', () => {
  it('drops a user\'s check-ins, distinct beers and sync state, case-insensitively, leaving others', async () => {
    const cache = CheckinCache.open(':memory:');
    await seed(cache, 'alice', 3);
    await seed(cache, 'bob', 2);
    const removed = await cache.forgetUser('ALICE');
    expect(removed).toEqual({ checkins: 3, distinct_beers: 3, sync_state: 1 });
    expect(await cache.cachedCount('alice')).toBe(0);
    expect(await cache.distinctBeersCount('alice')).toBe(0);
    expect(await cache.getState('alice')).toBeUndefined();
    expect(await cache.cachedCount('bob')).toBe(2);
    expect(await cache.distinctBeersCount('bob')).toBe(2);
    expect(await cache.getState('bob')).toBeDefined();
    cache.close();
  });
});

describe('untappd_cache_forget', () => {
  let cache: CheckinCache;
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  beforeEach(async () => {
    if (harness) await harness.close();
    cache = CheckinCache.open(':memory:');
    await seed(cache, 'alice', 3);
    await seed(cache, 'bob', 2);
    harness = await createTestHarness((server) => registerCacheTools(server, new UntappdClient(), () => cache));
  });
  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('previews the username and exact row counts, and deletes nothing without a token', async () => {
    const p1 = parse(await harness.callTool('untappd_cache_forget', { username: 'alice' }));
    expect(p1.status).toBe('confirmation-required');
    expect(typeof p1.confirmToken).toBe('string');
    expect(p1.preview).toMatchObject({ username: 'alice', checkins: 3, distinct_beers: 3 });
    expect(await cache.cachedCount('alice')).toBe(3);
  });

  it('with the confirmToken forgets only that user', async () => {
    const p1 = parse(await harness.callTool('untappd_cache_forget', { username: 'alice' }));
    const out = parse(await harness.callTool('untappd_cache_forget', { username: 'alice', confirmToken: p1.confirmToken }));
    expect(out).toMatchObject({ forgotten: true, username: 'alice', removed: { checkins: 3, distinct_beers: 3, sync_state: 1 } });
    expect(await cache.cachedCount('alice')).toBe(0);
    expect(await cache.cachedCount('bob')).toBe(2);
  });

  it('rejects a token when the cached rows changed after the preview', async () => {
    const p1 = parse(await harness.callTool('untappd_cache_forget', { username: 'alice' }));
    await seed(cache, 'alice', 5);
    const r = await harness.callTool('untappd_cache_forget', { username: 'alice', confirmToken: p1.confirmToken });
    const text = (r as { content: { text: string }[] }).content[0].text;
    expect((r as { isError?: boolean }).isError === true || /confirmation-required/.test(text)).toBe(true);
    expect(await cache.cachedCount('alice')).toBe(5);
  });

  it('is annotated destructive', async () => {
    const { tools } = await harness.client.listTools();
    const t = tools.find((x) => x.name === 'untappd_cache_forget');
    expect(t?.annotations?.destructiveHint).toBe(true);
    expect(t?.annotations?.openWorldHint).toBe(false);
  });
});
