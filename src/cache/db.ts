import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readEnvVar } from '@chrischall/mcp-utils';
import { CheckinStoreCore, LocalCacheStore, type SqlDriver, type SqlParam } from './store.js';

// The `node:sqlite` backend for the check-in cache — a local on-disk SQLite file
// used by the stdio/desktop server. The query logic lives in CheckinStoreCore
// (src/cache/store.ts); this file only adapts `node:sqlite` to the SqlDriver
// surface and manages the file handle. (The remote Cloudflare connector uses a
// Durable Object backend instead — see src/cache/durable.ts.)

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

  /** Open (creating parent dirs) a file-backed cache, or `:memory:` for tests. */
  static open(path: string): CheckinCache {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new CheckinCache(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
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
} from './store.js';
