import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { CheckinRow } from '../src/cache/store.js';
import { makeDurableCacheStore, durableCacheProvider, type UntappdCacheDO } from '../src/cache/durable.js';
import { registerCacheTools } from '../src/tools/cache.js';
import { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';

// Exercises the Durable Object cache backend inside the REAL Workers runtime
// (Miniflare via @cloudflare/vitest-pool-workers), against wrangler.jsonc's
// `CACHE_DO` binding. This is where the DO's SQLite storage adapter
// (src/cache/durable.ts) is proven — the Node suite can't run `cloudflare:workers`.

// `env` is untyped in the pool without an ambient Env; the CACHE_DO namespace is
// a real DurableObjectNamespace whose stub exposes the DO's RPC methods.
const CACHE = (env as unknown as { CACHE_DO: DurableObjectNamespace<UntappdCacheDO> }).CACHE_DO;

function row(checkin_id: number, over: Partial<CheckinRow> = {}): CheckinRow {
  return {
    checkin_id,
    username: 'mer1331',
    bid: checkin_id,
    beer_name: `Beer ${checkin_id}`,
    brewery_id: 7,
    brewery_name: 'Brew Co',
    beer_style: 'IPA',
    abv: 6.5,
    rating: 4,
    comment: null,
    venue_id: 3,
    venue_name: 'The Pub',
    created_at: '2025-07-05T18:23:11.000Z',
    ...over,
  };
}

describe('UntappdCacheDO (Durable Object SQLite backend)', () => {
  it('round-trips both sources / hasHad / query / state over RPC, keyed case-insensitively', async () => {
    const stub = CACHE.get(CACHE.idFromName('mer1331'));

    const added = await stub.upsertCheckins('Mer1331', [row(11), row(22), row(33, { beer_style: 'Stout' })]);
    expect(added).toBe(3);
    expect(await stub.upsertCheckins('mer1331', [row(11, { rating: 5 })])).toBe(0); // dedupe on checkin_id
    expect(await stub.cachedCount('MER1331')).toBe(3);

    // The distinct-beers source (user/beers) over RPC — bid 44 not in the check-ins.
    await stub.upsertDistinctBeers('mer1331', [
      { username: 'mer1331', bid: 44, beer_name: 'Solo', brewery_id: 7, brewery_name: 'Brew Co', beer_style: 'IPA', abv: 6, rating: 4.5, had_count: 9, first_had: '2016-01-01T00:00:00.000Z', last_had: '2025-01-01T00:00:00.000Z' },
    ]);
    expect(await stub.distinctBeersCount('mer1331')).toBe(1);

    const fromCheckins = await stub.hasHad('mer1331', { bid: 22 });
    expect(fromCheckins.had).toBe(true);
    expect(fromCheckins.sources).toEqual(['checkins']);

    const fromBeers = await stub.hasHad('mer1331', { bid: 44 });
    expect(fromBeers.had).toBe(true);
    expect(fromBeers.count).toBe(9);
    expect(fromBeers.sources).toEqual(['beers']);

    expect((await stub.hasHad('mer1331', { bid: 999 })).had).toBe(false);

    await stub.setState('mer1331', { backfill_complete: true, newest_checkin_id: 33, beers_complete: true });
    const state = await stub.getState('mer1331');
    expect(state?.backfill_complete).toBe(true);
    expect(state?.beers_complete).toBe(true);

    // Beer-metadata cache (global, for untappd_top_not_had) round-trips over RPC.
    await stub.upsertBeerMeta([
      { bid: 4499, name: 'Pliny', brewery: 'RR', brewery_id: 5143, style: 'IPA - Imperial / Double', parent_style: 'India Pale Ale (IPA)', abv: 8, ibu: 100, weighted_rating_score: 4.49, rating_score: 4.48, rating_count: 305785, fetched_at: '2026-07-12T00:00:00.000Z' },
    ]);
    const meta = await stub.getBeerMeta([4499, 999999]);
    expect(meta.length).toBe(1);
    expect(meta[0].weighted_rating_score).toBeCloseTo(4.49);
  });

  it('keeps each operator’s cache isolated in its own DO', async () => {
    const a = CACHE.get(CACHE.idFromName('operator_a'));
    const b = CACHE.get(CACHE.idFromName('operator_b'));
    await a.upsertCheckins('a', [row(100)]);
    expect(await a.cachedCount('a')).toBe(1);
    // A different operator's DO is a separate database — no cross-contamination.
    expect(await b.cachedCount('a')).toBe(0);
  });
});

describe('worker cache wiring (regression for the env-threading bug)', () => {
  it('surfaces a clear error — not an undefined TypeError — when the binding is missing', () => {
    // This is the exact failure mode the connector hit: no storage binding. It
    // must read as "CACHE_DO not configured", not "Cannot read properties of
    // undefined".
    expect(() => makeDurableCacheStore(undefined, 'someone')).toThrowError(/CACHE_DO/);
  });

  it('drives a cache tool end-to-end through MCP against the real DO binding', async () => {
    // Mirrors how worker.ts wires the store: a provider built from env.CACHE_DO,
    // handed to registerCacheTools. Exercises env → provider → store → DO → tool.
    const provider = durableCacheProvider(CACHE, 'regression_op');
    await provider().upsertCheckins('regression_op', [row(11), row(22)]);

    const harness = await createTestHarness((server) => registerCacheTools(server, new UntappdClient(), provider));
    try {
      const r = await harness.callTool('untappd_cache_not_had', { username: 'regression_op', bids: [11, 22, 77] });
      const out = JSON.parse((r as { content: { text: string }[] }).content[0].text);
      expect(out.not_had).toEqual([77]);
      expect(out.had).toEqual([11, 22]);
    } finally {
      await harness.close();
    }
  });
});
