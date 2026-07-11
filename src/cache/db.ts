import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readEnvVar } from '@chrischall/mcp-utils';

// A local, on-disk SQLite mirror of a user's Untappd check-in history. It exists
// because the Untappd API only exposes paged, most-recent-first lists (50/page)
// and NO "has user X ever had beer Y" lookup — answering that from the API means
// paging the entire history every time, against a ~100-calls/hour rate limit.
// We sync once (incrementally + resumable backfill) into this cache, then answer
// every "has had" / filter query locally with zero API calls.

/** One cached check-in row. Mirrors the `checkins` table columns. */
export interface CheckinRow {
  checkin_id: number;
  username: string;
  bid: number | null;
  beer_name: string | null;
  brewery_id: number | null;
  brewery_name: string | null;
  beer_style: string | null;
  abv: number | null;
  rating: number | null;
  comment: string | null;
  venue_id: number | null;
  venue_name: string | null;
  created_at: string | null;
}

/** Per-username sync bookkeeping. Mirrors the `sync_state` table. */
export interface SyncState {
  username: string;
  /** pagination.max_id cursor for the NEXT older page (backfill resume point). */
  oldest_max_id: number | null;
  /**
   * Top of the CONTIGUOUS cached block — the incremental catch-up boundary.
   * Only advanced once a catch-up run has connected the new-top region down to
   * this point, so it never runs ahead of a gap.
   */
  newest_checkin_id: number | null;
  /**
   * Resume cursor for an in-progress incremental catch-up (the new-top region).
   * Non-null means a catch-up did NOT finish within a run's page budget: the
   * next run resumes paging from here instead of restarting at the very top, so
   * a >`max_pages`*50 burst of new check-ins can never strand a permanent gap.
   */
  catchup_max_id: number | null;
  last_synced_at: string | null;
  backfill_complete: boolean;
  /** stats.total_checkins from the last user_info fetch (for a % estimate). */
  total_checkins: number | null;
}

export interface HasHadResult {
  had: boolean;
  count: number;
  last_date: string | null;
  best_rating: number | null;
  matches: Array<Pick<CheckinRow, 'checkin_id' | 'bid' | 'beer_name' | 'rating' | 'venue_name' | 'created_at'>>;
}

export interface QueryFilters {
  brewery_id?: number;
  brewery?: string;
  style?: string;
  min_rating?: number;
  venue?: string;
  venue_id?: number;
  date_from?: string;
  date_to?: string;
  sort?: 'recent' | 'oldest' | 'highest_rated' | 'lowest_rated';
  limit?: number;
}

/** The default check-in a raw API list item maps to when a field is absent. */
type Dict = Record<string, unknown>;
function asDict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Normalise a raw `/user/checkins` item to a {@link CheckinRow}. Reads only the
 * documented list fields (the same ones `compactCheckin` uses) and derives
 * nothing it can't. `created_at` is normalised to ISO-8601 UTC so it sorts
 * lexicographically = chronologically and date-range filters are plain string
 * comparisons; the raw RFC-2822 string is kept if it can't be parsed.
 */
export function mapCheckinRow(username: string, item: unknown): CheckinRow | null {
  const c = asDict(item);
  const checkin_id = num(c.checkin_id);
  if (checkin_id === null) return null; // can't key it — skip rather than corrupt the table
  const beer = asDict(c.beer);
  const brewery = asDict(c.brewery);
  const venue = asDict(c.venue); // Untappd sends `venue: []` when none — asDict → {}
  return {
    checkin_id,
    username,
    bid: num(beer.bid),
    beer_name: str(beer.beer_name),
    brewery_id: num(brewery.brewery_id),
    brewery_name: str(brewery.brewery_name),
    beer_style: str(beer.beer_style),
    abv: num(beer.beer_abv),
    rating: num(c.rating_score),
    comment: str(c.checkin_comment),
    venue_id: num(venue.venue_id),
    venue_name: str(venue.venue_name),
    created_at: normaliseDate(c.created_at),
  };
}

function normaliseDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkins (
  checkin_id   INTEGER PRIMARY KEY,
  username     TEXT NOT NULL,
  bid          INTEGER,
  beer_name    TEXT,
  brewery_id   INTEGER,
  brewery_name TEXT,
  beer_style   TEXT,
  abv          REAL,
  rating       REAL,
  comment      TEXT,
  venue_id     INTEGER,
  venue_name   TEXT,
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkins_user_bid ON checkins(username, bid);
CREATE INDEX IF NOT EXISTS idx_checkins_user_brewery ON checkins(username, brewery_id);

CREATE TABLE IF NOT EXISTS sync_state (
  username          TEXT PRIMARY KEY,
  oldest_max_id     INTEGER,
  newest_checkin_id INTEGER,
  catchup_max_id    INTEGER,
  last_synced_at    TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  total_checkins    INTEGER
);
`;

/**
 * Wraps a single SQLite database file. Usernames are compared
 * case-insensitively via a lowercased key so `Mer1331` and `mer1331` share one
 * cache; the original casing the caller passed is preserved in stored rows.
 */
export class CheckinCache {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // Forward-compat for a sync_state table created before a column existed. Each
  // ADD COLUMN throws harmlessly if the column is already present.
  private migrate(): void {
    for (const col of ['catchup_max_id INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE sync_state ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
  }

  /** Open (creating parent dirs) a file-backed cache, or `:memory:` for tests. */
  static open(path: string): CheckinCache {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new CheckinCache(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Upsert a batch of rows (dedupe on checkin_id) inside one transaction and
   * return the NET number of newly-inserted rows (updates to existing rows count
   * as 0), which is what "rows added" reports.
   */
  upsertCheckins(username: string, rows: CheckinRow[]): number {
    if (rows.length === 0) return 0;
    const key = username.toLowerCase();
    const before = this.cachedCount(username);
    const stmt = this.db.prepare(`
      INSERT INTO checkins
        (checkin_id, username, bid, beer_name, brewery_id, brewery_name, beer_style, abv, rating, comment, venue_id, venue_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkin_id) DO UPDATE SET
        username=excluded.username, bid=excluded.bid, beer_name=excluded.beer_name,
        brewery_id=excluded.brewery_id, brewery_name=excluded.brewery_name, beer_style=excluded.beer_style,
        abv=excluded.abv, rating=excluded.rating, comment=excluded.comment,
        venue_id=excluded.venue_id, venue_name=excluded.venue_name, created_at=excluded.created_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        stmt.run(
          r.checkin_id,
          key,
          r.bid,
          r.beer_name,
          r.brewery_id,
          r.brewery_name,
          r.beer_style,
          r.abv,
          r.rating,
          r.comment,
          r.venue_id,
          r.venue_name,
          r.created_at,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.cachedCount(username) - before;
  }

  /** Total cached check-ins for a user (= distinct check-ins, since PK is checkin_id). */
  cachedCount(username: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM checkins WHERE username = ?')
      .get(username.toLowerCase()) as { n: number };
    return row.n;
  }

  /** Distinct beers (unique bids) cached for a user. */
  distinctBeerCount(username: string): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT bid) AS n FROM checkins WHERE username = ? AND bid IS NOT NULL')
      .get(username.toLowerCase()) as { n: number };
    return row.n;
  }

  /** Highest cached checkin_id for a user (the true newest once contiguous), or null. */
  newestCachedId(username: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(checkin_id) AS m FROM checkins WHERE username = ?')
      .get(username.toLowerCase()) as { m: number | null };
    return row.m;
  }

  getState(username: string): SyncState | undefined {
    const row = this.db.prepare('SELECT * FROM sync_state WHERE username = ?').get(username.toLowerCase()) as
      | (Omit<SyncState, 'backfill_complete'> & { backfill_complete: number })
      | undefined;
    if (!row) return undefined;
    return { ...row, username: row.username, backfill_complete: row.backfill_complete === 1 };
  }

  /**
   * Insert-or-merge sync state. Only keys PRESENT in `patch` are written, so an
   * explicit `null` (e.g. clearing `oldest_max_id` when backfill completes)
   * overrides the stored value — a `??` merge could not do that.
   */
  setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): void {
    const key = username.toLowerCase();
    const cur = this.getState(key);
    const pick = <K extends keyof Omit<SyncState, 'username'>>(k: K, fallback: SyncState[K]): SyncState[K] =>
      k in patch ? (patch[k] as SyncState[K]) : (cur?.[k] ?? fallback);
    const next: SyncState = {
      username: key,
      oldest_max_id: pick('oldest_max_id', null),
      newest_checkin_id: pick('newest_checkin_id', null),
      catchup_max_id: pick('catchup_max_id', null),
      last_synced_at: pick('last_synced_at', null),
      backfill_complete: pick('backfill_complete', false),
      total_checkins: pick('total_checkins', null),
    };
    this.db
      .prepare(
        `INSERT INTO sync_state (username, oldest_max_id, newest_checkin_id, catchup_max_id, last_synced_at, backfill_complete, total_checkins)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET
           oldest_max_id=excluded.oldest_max_id, newest_checkin_id=excluded.newest_checkin_id,
           catchup_max_id=excluded.catchup_max_id,
           last_synced_at=excluded.last_synced_at, backfill_complete=excluded.backfill_complete,
           total_checkins=excluded.total_checkins`,
      )
      .run(
        key,
        next.oldest_max_id,
        next.newest_checkin_id,
        next.catchup_max_id,
        next.last_synced_at,
        next.backfill_complete ? 1 : 0,
        next.total_checkins,
      );
  }

  /** Exact bid match or case-insensitive substring match on beer name. */
  hasHad(username: string, opts: { bid?: number; beerName?: string }): HasHadResult {
    const where: string[] = ['username = ?'];
    const params: Array<string | number> = [username.toLowerCase()];
    if (opts.bid !== undefined) {
      where.push('bid = ?');
      params.push(opts.bid);
    }
    if (opts.beerName !== undefined) {
      where.push('beer_name LIKE ? COLLATE NOCASE');
      params.push(`%${escapeLike(opts.beerName)}%`);
    }
    const clause = where.join(' AND ');
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS n, MAX(rating) AS best FROM checkins WHERE ${clause}`)
      .get(...params) as { n: number; best: number | null };
    // Most-recent first: checkin_id is monotonic in time, a reliable ordering
    // even though created_at is a formatted string.
    const matches = this.db
      .prepare(
        `SELECT checkin_id, bid, beer_name, rating, venue_name, created_at
         FROM checkins WHERE ${clause} ORDER BY checkin_id DESC LIMIT 25`,
      )
      .all(...params) as HasHadResult['matches'];
    return {
      had: agg.n > 0,
      count: agg.n,
      last_date: matches[0]?.created_at ?? null,
      best_rating: agg.best,
      matches,
    };
  }

  query(username: string, filters: QueryFilters): CheckinRow[] {
    const where: string[] = ['username = ?'];
    const params: Array<string | number> = [username.toLowerCase()];
    if (filters.brewery_id !== undefined) {
      where.push('brewery_id = ?');
      params.push(filters.brewery_id);
    }
    if (filters.brewery !== undefined) {
      where.push('brewery_name LIKE ? COLLATE NOCASE');
      params.push(`%${escapeLike(filters.brewery)}%`);
    }
    if (filters.style !== undefined) {
      where.push('beer_style LIKE ? COLLATE NOCASE');
      params.push(`%${escapeLike(filters.style)}%`);
    }
    if (filters.min_rating !== undefined) {
      where.push('rating >= ?');
      params.push(filters.min_rating);
    }
    if (filters.venue !== undefined) {
      where.push('venue_name LIKE ? COLLATE NOCASE');
      params.push(`%${escapeLike(filters.venue)}%`);
    }
    if (filters.venue_id !== undefined) {
      where.push('venue_id = ?');
      params.push(filters.venue_id);
    }
    // created_at is ISO-8601, so a YYYY-MM-DD bound compares correctly on its date prefix.
    if (filters.date_from !== undefined) {
      where.push('substr(created_at, 1, 10) >= ?');
      params.push(filters.date_from);
    }
    if (filters.date_to !== undefined) {
      where.push('substr(created_at, 1, 10) <= ?');
      params.push(filters.date_to);
    }
    const order =
      filters.sort === 'oldest'
        ? 'checkin_id ASC'
        : filters.sort === 'highest_rated'
          ? 'rating DESC, checkin_id DESC'
          : filters.sort === 'lowest_rated'
            ? 'rating ASC, checkin_id DESC'
            : 'checkin_id DESC';
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM checkins WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...params, limit) as unknown as CheckinRow[];
    return rows;
  }
}

// Escape LIKE wildcards in user input so a literal % or _ isn't treated as a
// wildcard. Our LIKE patterns don't set an ESCAPE clause, so we only need to
// avoid a query that matches unexpectedly; backslash-escaping the specials and
// pairing with the default is not portable, so we simply strip them.
function escapeLike(s: string): string {
  return s.replace(/[%_]/g, ' ');
}

/** Default on-disk cache path: `$UNTAPPD_CACHE_DB` or `~/.untappd-mcp/checkins.db`. */
export function defaultCachePath(): string {
  return readEnvVar('UNTAPPD_CACHE_DB') ?? join(homedir(), '.untappd-mcp', 'checkins.db');
}
