// Storage-agnostic core for the Untappd check-in cache.
//
// The cache exists because the Untappd API only exposes paged, most-recent-first
// lists (50/page) and NO "has user X ever had beer Y" lookup — answering that
// from the API means paging the entire history every time, against a
// ~100-calls/hour rate limit. We sync once (incrementally + resumable backfill)
// into this cache, then answer every "has had" / filter query locally with zero
// API calls.
//
// The SQL logic lives here ONCE, parameterised over a tiny synchronous
// {@link SqlDriver}, so the exact same schema and queries back both storage
// engines: `node:sqlite` on the stdio server (src/cache/db.ts) and a Cloudflare
// Durable Object's SQLite storage on the remote connector (src/cache/durable.ts).
// This module imports nothing platform-specific so it is safe in both the Node
// and Workers bundles.

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

/**
 * The async cache surface the sync logic and MCP tools depend on. It is async
 * because the Worker backend answers over a Durable Object RPC boundary; the
 * node backend fulfils it synchronously behind resolved promises.
 */
export interface CacheStore {
  upsertCheckins(username: string, rows: CheckinRow[]): Promise<number>;
  cachedCount(username: string): Promise<number>;
  distinctBeerCount(username: string): Promise<number>;
  newestCachedId(username: string): Promise<number | null>;
  getState(username: string): Promise<SyncState | undefined>;
  setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): Promise<void>;
  hasHad(username: string, opts: { bid?: number; beerName?: string }): Promise<HasHadResult>;
  query(username: string, filters: QueryFilters): Promise<CheckinRow[]>;
}

export type SqlParam = string | number | null;
type Row = Record<string, unknown>;

/**
 * Minimal synchronous SQLite surface the core needs. Both `node:sqlite` and a
 * Durable Object's `SqlStorage` implement it trivially (see the two drivers).
 */
export interface SqlDriver {
  /** Run a multi-statement DDL script (schema creation). */
  execScript(sql: string): void;
  /** Run one statement for its side effects. */
  run(sql: string, params: SqlParam[]): void;
  /** Run one statement and return the first row, if any. */
  get(sql: string, params: SqlParam[]): Row | undefined;
  /** Run one statement and return all rows. */
  all(sql: string, params: SqlParam[]): Row[];
  /** Run `fn` atomically (all-or-nothing). */
  transaction(fn: () => void): void;
}

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

/** Schema statements, split so a driver that only runs one statement per call works. */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS checkins (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_checkins_user_bid ON checkins(username, bid)`,
  `CREATE INDEX IF NOT EXISTS idx_checkins_user_brewery ON checkins(username, brewery_id)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
     username          TEXT PRIMARY KEY,
     oldest_max_id     INTEGER,
     newest_checkin_id INTEGER,
     catchup_max_id    INTEGER,
     last_synced_at    TEXT,
     backfill_complete INTEGER NOT NULL DEFAULT 0,
     total_checkins    INTEGER
   )`,
];

/** Columns added after the initial release, applied idempotently on open. */
export const MIGRATIONS = ['ALTER TABLE sync_state ADD COLUMN catchup_max_id INTEGER'];

/**
 * The check-in cache logic over a synchronous {@link SqlDriver}. Usernames are
 * keyed case-insensitively via a lowercased key so `Mer1331` and `mer1331` share
 * one cache; stored rows keep whatever casing they arrived with in other fields.
 */
export class CheckinStoreCore {
  constructor(private readonly db: SqlDriver) {
    for (const stmt of SCHEMA_STATEMENTS) this.db.execScript(stmt);
    // Forward-compat for a sync_state table created before a column existed; the
    // ADD COLUMN throws harmlessly if the column is already present.
    for (const mig of MIGRATIONS) {
      try {
        this.db.execScript(mig);
      } catch {
        /* column already exists */
      }
    }
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
    const sql = `
      INSERT INTO checkins
        (checkin_id, username, bid, beer_name, brewery_id, brewery_name, beer_style, abv, rating, comment, venue_id, venue_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkin_id) DO UPDATE SET
        username=excluded.username, bid=excluded.bid, beer_name=excluded.beer_name,
        brewery_id=excluded.brewery_id, brewery_name=excluded.brewery_name, beer_style=excluded.beer_style,
        abv=excluded.abv, rating=excluded.rating, comment=excluded.comment,
        venue_id=excluded.venue_id, venue_name=excluded.venue_name, created_at=excluded.created_at`;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(sql, [
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
        ]);
      }
    });
    return this.cachedCount(username) - before;
  }

  /** Total cached check-ins for a user (= distinct check-ins, since PK is checkin_id). */
  cachedCount(username: string): number {
    const row = this.db.get('SELECT COUNT(*) AS n FROM checkins WHERE username = ?', [username.toLowerCase()]);
    return Number(row?.n ?? 0);
  }

  /** Distinct beers (unique bids) cached for a user. */
  distinctBeerCount(username: string): number {
    const row = this.db.get(
      'SELECT COUNT(DISTINCT bid) AS n FROM checkins WHERE username = ? AND bid IS NOT NULL',
      [username.toLowerCase()],
    );
    return Number(row?.n ?? 0);
  }

  /** Highest cached checkin_id for a user (the true newest once contiguous), or null. */
  newestCachedId(username: string): number | null {
    const row = this.db.get('SELECT MAX(checkin_id) AS m FROM checkins WHERE username = ?', [username.toLowerCase()]);
    return num(row?.m);
  }

  getState(username: string): SyncState | undefined {
    const row = this.db.get('SELECT * FROM sync_state WHERE username = ?', [username.toLowerCase()]);
    if (!row) return undefined;
    return {
      username: String(row.username),
      oldest_max_id: num(row.oldest_max_id),
      newest_checkin_id: num(row.newest_checkin_id),
      catchup_max_id: num(row.catchup_max_id),
      last_synced_at: str(row.last_synced_at),
      backfill_complete: Number(row.backfill_complete) === 1,
      total_checkins: num(row.total_checkins),
    };
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
    this.db.run(
      `INSERT INTO sync_state (username, oldest_max_id, newest_checkin_id, catchup_max_id, last_synced_at, backfill_complete, total_checkins)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         oldest_max_id=excluded.oldest_max_id, newest_checkin_id=excluded.newest_checkin_id,
         catchup_max_id=excluded.catchup_max_id,
         last_synced_at=excluded.last_synced_at, backfill_complete=excluded.backfill_complete,
         total_checkins=excluded.total_checkins`,
      [
        key,
        next.oldest_max_id,
        next.newest_checkin_id,
        next.catchup_max_id,
        next.last_synced_at,
        next.backfill_complete ? 1 : 0,
        next.total_checkins,
      ],
    );
  }

  /** Exact bid match or case-insensitive substring match on beer name. */
  hasHad(username: string, opts: { bid?: number; beerName?: string }): HasHadResult {
    const where: string[] = ['username = ?'];
    const params: SqlParam[] = [username.toLowerCase()];
    if (opts.bid !== undefined) {
      where.push('bid = ?');
      params.push(opts.bid);
    }
    if (opts.beerName !== undefined) {
      where.push('beer_name LIKE ? COLLATE NOCASE');
      params.push(`%${escapeLike(opts.beerName)}%`);
    }
    const clause = where.join(' AND ');
    const agg = this.db.get(`SELECT COUNT(*) AS n, MAX(rating) AS best FROM checkins WHERE ${clause}`, params);
    // Most-recent first: checkin_id is monotonic in time, a reliable ordering
    // even though created_at is a formatted string.
    const matches = this.db.all(
      `SELECT checkin_id, bid, beer_name, rating, venue_name, created_at
       FROM checkins WHERE ${clause} ORDER BY checkin_id DESC LIMIT 25`,
      params,
    ) as HasHadResult['matches'];
    const count = Number(agg?.n ?? 0);
    return {
      had: count > 0,
      count,
      last_date: matches[0]?.created_at ?? null,
      best_rating: num(agg?.best),
      matches,
    };
  }

  query(username: string, filters: QueryFilters): CheckinRow[] {
    const where: string[] = ['username = ?'];
    const params: SqlParam[] = [username.toLowerCase()];
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
    return this.db.all(
      `SELECT * FROM checkins WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      [...params, limit],
    ) as unknown as CheckinRow[];
  }
}

/**
 * Adapts a synchronous {@link CheckinStoreCore} to the async {@link CacheStore}
 * interface. Used by the in-process node backend; the Durable Object backend
 * implements CacheStore over a real RPC boundary instead.
 */
export class LocalCacheStore implements CacheStore {
  constructor(protected readonly core: CheckinStoreCore) {}
  async upsertCheckins(username: string, rows: CheckinRow[]): Promise<number> {
    return this.core.upsertCheckins(username, rows);
  }
  async cachedCount(username: string): Promise<number> {
    return this.core.cachedCount(username);
  }
  async distinctBeerCount(username: string): Promise<number> {
    return this.core.distinctBeerCount(username);
  }
  async newestCachedId(username: string): Promise<number | null> {
    return this.core.newestCachedId(username);
  }
  async getState(username: string): Promise<SyncState | undefined> {
    return this.core.getState(username);
  }
  async setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): Promise<void> {
    this.core.setState(username, patch);
  }
  async hasHad(username: string, opts: { bid?: number; beerName?: string }): Promise<HasHadResult> {
    return this.core.hasHad(username, opts);
  }
  async query(username: string, filters: QueryFilters): Promise<CheckinRow[]> {
    return this.core.query(username, filters);
  }
}

// Escape LIKE wildcards in user input so a literal % or _ isn't treated as a
// wildcard. Our LIKE patterns don't set an ESCAPE clause, so we simply strip the
// specials rather than rely on a non-portable escape convention.
function escapeLike(s: string): string {
  return s.replace(/[%_]/g, ' ');
}
