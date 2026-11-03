import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CheckinCache, defaultCachePath } from '../src/cache/db.js';
import { SCHEMA_STATEMENTS, SCHEMA_VERSION, VERSIONED_MIGRATIONS } from '../src/cache/store.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'untappd-mig-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The schema as the FIRST release wrote it: no user_version, sync_state
 * without any of the later columns, no item_resolutions table.
 */
function writeLegacyCache(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE checkins (
      checkin_id INTEGER PRIMARY KEY, username TEXT NOT NULL, bid INTEGER, beer_name TEXT,
      brewery_id INTEGER, brewery_name TEXT, beer_style TEXT, abv REAL, rating REAL, comment TEXT,
      venue_id INTEGER, venue_name TEXT, created_at TEXT);
    CREATE TABLE distinct_beers (
      username TEXT NOT NULL, bid INTEGER NOT NULL, beer_name TEXT, brewery_id INTEGER, brewery_name TEXT,
      beer_style TEXT, abv REAL, rating REAL, had_count INTEGER, first_had TEXT, last_had TEXT,
      PRIMARY KEY (username, bid));
    CREATE TABLE beer_meta (
      bid INTEGER PRIMARY KEY, name TEXT, brewery TEXT, brewery_id INTEGER, style TEXT, parent_style TEXT,
      abv REAL, ibu REAL, weighted_rating_score REAL, rating_score REAL, rating_count INTEGER, fetched_at TEXT);
    CREATE TABLE sync_state (
      username TEXT PRIMARY KEY, oldest_max_id INTEGER, newest_checkin_id INTEGER, last_synced_at TEXT,
      backfill_complete INTEGER NOT NULL DEFAULT 0, total_checkins INTEGER);
    INSERT INTO checkins (checkin_id, username, bid, beer_name) VALUES (1, 'mer', 304831, 'Tennessee Lager');
    INSERT INTO distinct_beers (username, bid, beer_name, had_count) VALUES ('mer', 1893601, 'Fennario', 3);
    INSERT INTO sync_state (username, last_synced_at, backfill_complete, total_checkins)
      VALUES ('mer', '2025-01-01T00:00:00.000Z', 1, 1);
  `);
  db.close();
}


/** A v3 cache as release 2.4.0 wrote it, with data in every table. */
function writeV3Cache(path: string): void {
  const db = new DatabaseSync(path);
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  for (const m of VERSIONED_MIGRATIONS) if (m.version <= 3) for (const stmt of m.statements) db.exec(stmt);
  db.exec(`
    PRAGMA user_version = 3;
    INSERT INTO checkins (checkin_id, username, bid, beer_name, venue_id, venue_name, created_at)
      VALUES (1, 'mer', 304831, 'Tennessee Lager', 77, 'Bar', '2024-01-01T00:00:00.000Z'),
             (2, 'mer', 1893601, 'Fennario', NULL, NULL, '2024-02-01T00:00:00.000Z');
    INSERT INTO distinct_beers (username, bid, beer_name, had_count, rating) VALUES ('mer', 1893601, 'Fennario', 3, 4.25),
      ('mer', 304831, 'Tennessee Lager', 1, NULL);
    INSERT INTO beer_meta (bid, name, rating_score, fetched_at) VALUES (1893601, 'Fennario', 3.9, '2026-10-01T00:00:00.000Z');
    INSERT INTO sync_state (username, last_synced_at, backfill_complete, total_checkins, beers_offset, beers_total,
                            beers_complete, beers_accepted_gap)
      VALUES ('mer', '2026-10-01T00:00:00.000Z', 1, 2, 100, 2, 1, 1);
    INSERT INTO item_resolutions (key, item, status, bid, data, resolved_at)
      VALUES ('v1|fennario', 'FENNARIO', 'resolved', 1893601, '{}', '2026-10-01T00:00:00.000Z');
  `);
  db.close();
}

const V3_TABLES = ['checkins', 'distinct_beers', 'beer_meta', 'sync_state', 'item_resolutions'];
function dumpV3Tables(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path);
  try {
    return Object.fromEntries(V3_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

describe('cache schema migration', () => {
  it('migrates a pre-versioning cache in place, keeping every row', async () => {
    const path = join(tmp(), 'checkins.db');
    writeLegacyCache(path);
    const cache = CheckinCache.open(path);
    try {
      expect(SCHEMA_VERSION).toBe(4);
      expect((await cache.stats()).schema_version).toBe(4);
      // Old rows survive…
      expect(await cache.cachedCount('mer')).toBe(1);
      expect(await cache.distinctBeersCount('mer')).toBe(1);
      expect((await cache.hasHad('mer', { bid: 1893601 })).count).toBe(3);
      // …old state reads back with the later columns defaulted…
      expect(await cache.getState('mer')).toMatchObject({
        last_synced_at: '2025-01-01T00:00:00.000Z',
        backfill_complete: true,
        beers_complete: false,
        beers_offset: null,
        beers_accepted_gap: 0,
      });
      // …and both the new columns and the new table are writable.
      await cache.setState('mer', { beers_offset: 50, beers_total: 200 });
      expect((await cache.getState('mer'))?.beers_offset).toBe(50);
      await cache.upsertResolutions([
        { key: 'k', item: 'X', status: 'unresolved', bid: null, data: '{"reason":"r"}', resolved_at: new Date().toISOString() },
      ]);
      expect((await cache.stats()).resolution_cache_entries).toBe(1);
    } finally {
      cache.close();
    }
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    raw.close();
  });

  it('re-opening a current cache is a no-op', async () => {
    const path = join(tmp(), 'checkins.db');
    const a = CheckinCache.open(path);
    await a.upsertDistinctBeers('mer', [
      { username: 'mer', bid: 1, beer_name: 'B', brewery_id: null, brewery_name: null, beer_style: null, abv: null, rating: null, had_count: 1, first_had: null, last_had: null },
    ]);
    a.close();
    const b = CheckinCache.open(path);
    expect(await b.distinctBeersCount('mer')).toBe(1);
    expect((await b.stats()).schema_version).toBe(4);
    b.close();
  });

  it('steps a v2 cache to v3 (adds the created_at index) without touching rows', async () => {
    const path = join(tmp(), 'checkins.db');
    const first = CheckinCache.open(path);
    await first.setState('mer', { beers_total: 7 });
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP INDEX idx_checkins_user_created; PRAGMA user_version = 2');
    raw.close();
    const cache = CheckinCache.open(path);
    expect((await cache.stats()).schema_version).toBe(4);
    expect((await cache.getState('mer'))?.beers_total).toBe(7);
    cache.close();
    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_checkins_user_created'").get()).toBeDefined();
    after.close();
  });

  it('steps a POPULATED v3 cache to v4: adds every new table, leaves existing rows and state untouched', async () => {
    const path = join(tmp(), 'checkins.db');
    writeV3Cache(path);
    const before = dumpV3Tables(path);
    const cache = CheckinCache.open(path);
    try {
      expect((await cache.stats()).schema_version).toBe(4);
      // Existing data reads back exactly as before.
      expect(await cache.cachedCount('mer')).toBe(2);
      expect(await cache.distinctBeersCount('mer')).toBe(2);
      expect((await cache.hasHad('mer', { bid: 1893601 })).count).toBe(3);
      expect(await cache.getState('mer')).toMatchObject({
        beers_offset: 100, beers_total: 2, beers_complete: true, beers_accepted_gap: 1, total_checkins: 2,
      });
      expect((await cache.getBeerMeta([1893601]))[0]).toMatchObject({ name: 'Fennario', rating_score: 3.9 });
      expect((await cache.getResolutions(['v1|fennario']))[0]).toMatchObject({ status: 'resolved', bid: 1893601 });
    } finally {
      cache.close();
    }
    // Byte-for-byte the same rows in every pre-existing table.
    expect(dumpV3Tables(path)).toEqual(before);

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
      const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols('venues')).toEqual([
        'venue_id', 'name', 'category', 'address', 'city', 'state', 'country', 'lat', 'lng', 'is_verified', 'updated_at',
      ]);
      expect(cols('user_venues')).toEqual([
        'username', 'venue_id', 'first_visit', 'first_checkin_id', 'recent_visit', 'recent_checkin_id', 'total_count', 'synced_at',
      ]);
      expect(cols('list_sync_state')).toEqual(
        expect.arrayContaining(['username', 'list', 'next_offset', 'total_count', 'complete', 'last_synced_at']),
      );
      expect(cols('brewery_beer_lists')).toEqual(expect.arrayContaining(['brewery_id', 'ranked_count', 'fetched_at']));
      expect(cols('brewery_beers')).toEqual(
        expect.arrayContaining(['brewery_id', 'bid', 'beer_name', 'style', 'abv', 'rating_score', 'checkin_count', 'in_production', 'popularity_rank']),
      );
      expect(cols('response_cache')).toEqual(expect.arrayContaining(['key', 'kind', 'data', 'fetched_at']));
      expect(cols('wishlist')).toEqual(expect.arrayContaining(['username', 'bid', 'beer_name', 'brewery_id', 'added_at', 'synced_at']));
      expect(cols('favorites')).toEqual(['username', 'kind', 'id', 'note', 'created_at']);
      expect(cols('venue_drinks')).toEqual(
        expect.arrayContaining(['username', 'venue_id', 'checkin_id', 'bid', 'beer_name', 'created_at', 'fetched_at']),
      );
      expect(cols('api_calls')).toEqual(expect.arrayContaining(['at', 'status', 'remaining', 'limit_hdr', 'reset_at', 'retry_after_s']));
      // favorites.kind is constrained to the three spec'd kinds.
      raw.prepare("INSERT INTO favorites (username, kind, id, created_at) VALUES ('mer', 'venue', 1, 'x')").run();
      expect(() => raw.prepare("INSERT INTO favorites (username, kind, id, created_at) VALUES ('mer', 'bar', 1, 'x')").run()).toThrow();
    } finally {
      raw.close();
    }
  });

  it('forget also drops the new per-user tables (venue history is personal data), keeping shared ones', async () => {
    const cache = CheckinCache.open(':memory:');
    const db = (cache as unknown as { db: DatabaseSync }).db;
    db.exec(`
      INSERT INTO venues (venue_id, name, updated_at) VALUES (1, 'V', 'x');
      INSERT INTO user_venues (username, venue_id, total_count, synced_at) VALUES ('alice', 1, 3, 'x'), ('bob', 1, 1, 'x');
      INSERT INTO list_sync_state (username, list, complete) VALUES ('alice', 'venues', 0);
      INSERT INTO wishlist (username, bid, synced_at) VALUES ('alice', 5, 'x');
      INSERT INTO favorites (username, kind, id, created_at) VALUES ('alice', 'beer', 5, 'x');
      INSERT INTO venue_drinks (username, venue_id, checkin_id, fetched_at) VALUES ('alice', 1, 9, 'x');
    `);
    const removed = await cache.forgetUser('ALICE');
    expect(removed).toMatchObject({ user_venues: 1, list_sync_state: 1, wishlist: 1, favorites: 1, venue_drinks: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_venues WHERE username = 'bob'").get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM venues').get()).toEqual({ n: 1 });
    cache.close();
  });

  it('persists the API call log and prunes entries older than two hours', async () => {
    const cache = CheckinCache.open(':memory:');
    const now = Date.now();
    const o = (at: number) => ({ at, status: 200, remaining: 0, limit: null, reset_at: null, retry_after_s: null });
    await cache.recordApiCalls([o(now - 3 * 3_600_000), o(now - 1000), o(now - 500)]);
    expect(await cache.recentApiCalls(now - 3_600_000)).toEqual([o(now - 1000), o(now - 500)]);
    const db = (cache as unknown as { db: DatabaseSync }).db;
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_calls').get()).toEqual({ n: 2 });
    cache.close();
  });

  it('leaves a cache written by a NEWER build untouched instead of downgrading it', async () => {
    const path = join(tmp(), 'checkins.db');
    const first = CheckinCache.open(path);
    await first.setState('mer', { beers_total: 7 });
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    const cache = CheckinCache.open(path);
    expect((await cache.stats()).schema_version).toBe(99);
    expect((await cache.getState('mer'))?.beers_total).toBe(7);
    cache.close();
    const after = new DatabaseSync(path);
    expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 });
    after.close();
  });

  it('opens the file in WAL mode', () => {
    const cache = CheckinCache.open(join(tmp(), 'checkins.db'));
    expect(cache.fileInfo().journal_mode).toBe('wal');
    cache.close();
  });
});

describe('defaultCachePath', () => {
  const saved = { db: process.env.UNTAPPD_CACHE_DB, dir: process.env.UNTAPPD_CACHE_DIR };
  afterEach(() => {
    for (const [k, v] of [['UNTAPPD_CACHE_DB', saved.db], ['UNTAPPD_CACHE_DIR', saved.dir]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to ~/.untappd-mcp/checkins.db', () => {
    delete process.env.UNTAPPD_CACHE_DB;
    delete process.env.UNTAPPD_CACHE_DIR;
    expect(defaultCachePath()).toBe(join(homedir(), '.untappd-mcp', 'checkins.db'));
  });

  it('UNTAPPD_CACHE_DIR picks the directory; UNTAPPD_CACHE_DB (a file) wins over it', () => {
    process.env.UNTAPPD_CACHE_DIR = '/srv/untappd';
    delete process.env.UNTAPPD_CACHE_DB;
    expect(defaultCachePath()).toBe('/srv/untappd/checkins.db');
    process.env.UNTAPPD_CACHE_DB = '/data/u.db';
    expect(defaultCachePath()).toBe('/data/u.db');
  });

  it('never resolves against the working directory: relative and ~ paths are anchored at HOME', () => {
    delete process.env.UNTAPPD_CACHE_DB;
    process.env.UNTAPPD_CACHE_DIR = 'cache/untappd';
    expect(defaultCachePath()).toBe(join(homedir(), 'cache', 'untappd', 'checkins.db'));
    process.env.UNTAPPD_CACHE_DB = '~/x/u.db';
    expect(defaultCachePath()).toBe(join(homedir(), 'x', 'u.db'));
  });
});
