import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CheckinCache, defaultCachePath } from '../src/cache/db.js';
import { SCHEMA_VERSION } from '../src/cache/store.js';

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

describe('cache schema migration', () => {
  it('migrates a pre-versioning cache in place, keeping every row', async () => {
    const path = join(tmp(), 'checkins.db');
    writeLegacyCache(path);
    const cache = CheckinCache.open(path);
    try {
      expect(SCHEMA_VERSION).toBe(3);
      expect((await cache.stats()).schema_version).toBe(3);
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
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
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
    expect((await b.stats()).schema_version).toBe(3);
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
    expect((await cache.stats()).schema_version).toBe(3);
    expect((await cache.getState('mer'))?.beers_total).toBe(7);
    cache.close();
    const after = new DatabaseSync(path);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_checkins_user_created'").get()).toBeDefined();
    after.close();
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
