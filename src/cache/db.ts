import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
    // IMMEDIATE takes the write lock up front. A DEFERRED transaction that
    // reads and then writes can hit SQLITE_BUSY on the lock upgrade, which
    // busy_timeout does NOT retry — the failure mode of two hosts open at once.
    this.db.exec('BEGIN IMMEDIATE');
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
  private constructor(
    private readonly db: DatabaseSync,
    /** Absolute path of the backing file, or `:memory:`. */
    readonly path: string,
  ) {
    super(new CheckinStoreCore(new NodeSqlDriver(db)));
  }

  /**
   * Open (creating parent dirs) a file-backed cache, or `:memory:` for tests.
   * The file holds other people's dated check-in and venue history, so it is
   * kept owner-only: dirs 0700, the db (and any -wal/-shm/-journal) 0600.
   */
  static open(path: string): CheckinCache {
    if (path !== ':memory:') preparePrivateFile(path);
    const db = new DatabaseSync(path);
    // Set before the schema/migration transaction so even that waits out a
    // second process instead of failing. WAL lets readers and one writer run
    // concurrently (two hosts open at once); NORMAL sync is the WAL-safe default.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    const cache = new CheckinCache(db, path);
    if (path !== ':memory:') tightenSidecars(path);
    return cache;
  }

  /** The SQLite journal mode actually in effect (`wal` for a file, `memory` for :memory:). */
  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    return String(row?.journal_mode ?? 'unknown');
  }

  /** On-disk footprint: the db file plus its -wal/-shm side files. */
  fileInfo(): { path: string; bytes: number; journal_mode: string } {
    let bytes = 0;
    if (this.path !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          bytes += statSync(this.path + suffix).size;
        } catch {
          /* side file not present */
        }
      }
    }
    return { path: this.path, bytes, journal_mode: this.journalMode() };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Create the cache's directory (0700 — `mode` applies to every dir mkdir
 * creates) and the db file itself (0600) BEFORE SQLite opens it, so the file is
 * never briefly umask-readable. The db file is always tightened, and so is the
 * server's own default directory (`~/.untappd-mcp`, which an older version may
 * have left loose). A directory the user pointed `UNTAPPD_CACHE_DB` into that
 * already existed is left as it is: it may hold other files (a shared Dropbox
 * folder), and making it owner-only would break access to them. chmod failures
 * (e.g. a shared dir the user doesn't own) are best-effort, never fatal.
 */
function preparePrivateFile(path: string): void {
  const dir = dirname(path);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!dirExisted || resolve(dir) === resolve(defaultCacheDir())) bestEffortChmod(dir, 0o700);
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

// How long a write waits for another process's lock before failing.
const BUSY_TIMEOUT_MS = 5000;

/**
 * The on-disk cache path, always ABSOLUTE: `$UNTAPPD_CACHE_DB` (a file), else
 * `$UNTAPPD_CACHE_DIR/checkins.db`, else `~/.untappd-mcp/checkins.db`.
 *
 * It must not depend on how the host launched the server — Claude Desktop runs
 * the .mcpb from its own extension dir, Claude Code from the project dir — so a
 * relative override resolves against the HOME directory, never the working
 * directory (which would silently give each host its own empty cache), and a
 * leading `~` is expanded.
 */
export function defaultCachePath(): string {
  const file = readEnvVar('UNTAPPD_CACHE_DB');
  if (file) return file === ':memory:' ? file : absolutise(file);
  const dir = readEnvVar('UNTAPPD_CACHE_DIR');
  return join(dir ? absolutise(dir) : defaultCacheDir(), 'checkins.db');
}

function absolutise(p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

/** One stderr line naming the resolved cache file, for the startup log. */
export function describeCachePath(path: string): string {
  let state = 'not created yet';
  try {
    // Count the -wal too: after an unclean exit most recent writes live there.
    let bytes = statSync(path).size;
    try {
      bytes += statSync(`${path}-wal`).size;
    } catch {
      /* no WAL */
    }
    state = `exists, ${bytes} bytes`;
  } catch {
    /* not created yet */
  }
  return `[untappd-mcp] cache: ${path} (${state})`;
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
  type CacheStats,
  type ItemResolution,
} from './store.js';

/** The directory the server owns by default: `~/.untappd-mcp`. */
function defaultCacheDir(): string {
  return join(homedir(), '.untappd-mcp');
}
