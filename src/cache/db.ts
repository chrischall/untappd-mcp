import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readEnvVar } from '@chrischall/mcp-utils';
import { CheckinStoreCore, LocalCacheStore, type SqlDriver, type SqlParam } from './store.js';

// The `node:sqlite` backend for the check-in cache — a local on-disk SQLite file
// used by the stdio/desktop server. The query logic lives in CheckinStoreCore
// (src/cache/store.ts); this file only adapts `node:sqlite` to the SqlDriver
// surface and manages the file handle. Another deployment can adapt a
// different driver to the same surface.

/** Adapts a `node:sqlite` DatabaseSync to the driver surface the core needs. */
class NodeSqlDriver implements SqlDriver {
  constructor(private readonly db: DatabaseSync) {}
  execScript(sql: string): void {
    this.db.exec(sql);
  }
  run(sql: string, params: SqlParam[]): void {
    this.db.prepare(sql).run(...params);
  }
  get(sql: string, params: SqlParam[]): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  }
  all(sql: string, params: SqlParam[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** A file-backed check-in cache. `open()` creates parent dirs and the schema. */
export class CheckinCache extends LocalCacheStore {
  private constructor(private readonly db: DatabaseSync) {
    super(new CheckinStoreCore(new NodeSqlDriver(db)));
  }

  /**
   * Open (creating parent dirs) a file-backed cache, or `:memory:` for tests.
   * The file holds other people's dated check-in and venue history, so it is
   * kept owner-only: dirs 0700, the db (and any -wal/-shm/-journal) 0600.
   */
  static open(path: string): CheckinCache {
    if (path !== ':memory:') preparePrivateFile(path);
    const cache = new CheckinCache(new DatabaseSync(path));
    if (path !== ':memory:') tightenSidecars(path);
    return cache;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Create the cache's directory (0700 — `mode` applies to every dir mkdir
 * creates) and the db file itself (0600) BEFORE SQLite opens it, so the file is
 * never briefly umask-readable. Pre-existing loose entries from older versions
 * are tightened too; chmod failures (e.g. a shared dir the user doesn't own)
 * are best-effort, never fatal.
 */
function preparePrivateFile(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  bestEffortChmod(dir, 0o700);
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
  bestEffortChmod(path, 0o600);
}

/** SQLite side files inherit the db's mode, but re-assert in case a loose one lingers. */
function tightenSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(path + suffix)) bestEffortChmod(path + suffix, 0o600);
  }
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* best-effort — not every filesystem supports POSIX modes */
  }
}

/** Default on-disk cache path: `$UNTAPPD_CACHE_DB` or `~/.untappd-mcp/checkins.db`. */
export function defaultCachePath(): string {
  return readEnvVar('UNTAPPD_CACHE_DB') ?? join(homedir(), '.untappd-mcp', 'checkins.db');
}

// Re-export the shared types/helpers tests and tools import from here so their
// existing import paths keep working.
export {
  mapCheckinRow,
  type CheckinRow,
  type SyncState,
  type HasHadResult,
  type QueryFilters,
  type CacheStore,
  type ForgetResult,
} from './store.js';
