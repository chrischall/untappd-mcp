// Storage-agnostic core for the Untappd check-in cache.
//
// The cache exists because the Untappd API only exposes paged lists (50/page)
// and NO "has user X ever had beer Y" lookup — answering that from the API means
// paging an entire history every time, against a ~100-calls/hour rate limit.
//
// Two independent sources fill the cache, in two tables:
//  - `checkins` (from user/checkins): real check-ins with venue/date/comment
//    detail. Fully pageable only for the authenticated account — for OTHER users
//    the endpoint returns just the ~50 most recent and refuses to page further.
//  - `distinct_beers` (from user/beers): every DISTINCT beer the user has ever
//    had, with the user's rating, times-had count, and first/last dates. Cheap
//    (thousands of rows vs tens of thousands of check-ins) and complete for
//    anyone — this is what gives full "has had" coverage.
//
// The SQL lives here ONCE, over a tiny synchronous {@link SqlDriver}, so the same
// schema/queries back both engines: `node:sqlite` on the stdio server and a
// Durable Object's SQLite on the connector. This module imports nothing
// platform-specific.

/** One real check-in row. Mirrors the `checkins` table columns. */
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

/** One distinct beer a user has had. Mirrors the `distinct_beers` table (keyed by username+bid). */
export interface DistinctBeerRow {
  username: string;
  bid: number;
  beer_name: string | null;
  brewery_id: number | null;
  brewery_name: string | null;
  beer_style: string | null;
  abv: number | null;
  /** The user's own rating of the beer, if any. */
  rating: number | null;
  /** How many times the user has had it (authoritative). */
  had_count: number | null;
  first_had: string | null;
  last_had: string | null;
}

/** Per-username sync bookkeeping. Mirrors the `sync_state` table. */
export interface SyncState {
  username: string;
  /** pagination.max_id cursor for the NEXT older page (checkins backfill resume point). */
  oldest_max_id: number | null;
  /** Top of the CONTIGUOUS cached checkins block — the incremental catch-up boundary. */
  newest_checkin_id: number | null;
  /** Resume cursor for an in-progress incremental catch-up (see sync.ts). */
  catchup_max_id: number | null;
  last_synced_at: string | null;
  /** True ONLY once the user/checkins backfill has cached ~all of total_checkins. */
  backfill_complete: boolean;
  /** stats.total_checkins from the last user_info fetch. */
  total_checkins: number | null;
  /**
   * True when user/checkins refused to page past the recent window (the case for
   * non-self accounts). Full has-had coverage then depends on the user/beers sync.
   */
  checkins_truncated: boolean;
  /** Next offset for the resumable user/beers sync. */
  beers_offset: number | null;
  /** total_count of distinct beers from the last user/beers response. */
  beers_total: number | null;
  /** True once the user/beers sync has paged the whole distinct-beer list. */
  beers_complete: boolean;
}

export interface HasHadResult {
  had: boolean;
  count: number;
  last_date: string | null;
  best_rating: number | null;
  /** Which source(s) the answer came from. */
  sources: Array<'checkins' | 'beers'>;
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
 * The async cache surface the sync logic and MCP tools depend on. Async because
 * the Worker backend answers over a Durable Object RPC boundary; the node backend
 * fulfils it synchronously behind resolved promises.
 */
export interface CacheStore {
  upsertCheckins(username: string, rows: CheckinRow[]): Promise<number>;
  upsertDistinctBeers(username: string, rows: DistinctBeerRow[]): Promise<number>;
  cachedCount(username: string): Promise<number>;
  /** Distinct beers in the `distinct_beers` table (user/beers coverage). */
  distinctBeersCount(username: string): Promise<number>;
  /** Distinct bids appearing in the `checkins` table. */
  checkinsBeerCount(username: string): Promise<number>;
  newestCachedId(username: string): Promise<number | null>;
  getState(username: string): Promise<SyncState | undefined>;
  setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): Promise<void>;
  hasHad(username: string, opts: { bid?: number; beerName?: string }): Promise<HasHadResult>;
  query(username: string, filters: QueryFilters): Promise<CheckinRow[]>;
}

export type SqlParam = string | number | null;
type Row = Record<string, unknown>;

/** Minimal synchronous SQLite surface the core needs; both drivers implement it trivially. */
export interface SqlDriver {
  execScript(sql: string): void;
  run(sql: string, params: SqlParam[]): void;
  get(sql: string, params: SqlParam[]): Row | undefined;
  all(sql: string, params: SqlParam[]): Row[];
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
 * Normalise a raw `/user/checkins` item to a {@link CheckinRow}. `created_at` is
 * normalised to ISO-8601 UTC so it sorts chronologically and date-range filters
 * are plain string comparisons; the raw RFC-2822 string is kept if unparseable.
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

/**
 * Normalise a raw `/user/beers` item to a {@link DistinctBeerRow}: one per
 * distinct beer, with the user's rating, times-had `had_count`, and first/last
 * dates. Tolerant of the field-name variants seen across the v4 API.
 */
export function mapBeerRow(username: string, item: unknown): DistinctBeerRow | null {
  const c = asDict(item);
  const beer = asDict(c.beer);
  const brewery = asDict(c.brewery);
  const bid = num(beer.bid);
  if (bid === null) return null;
  const rating = num(c.user_rating_score) ?? num(c.user_auth_rating_score);
  return {
    username,
    bid,
    beer_name: str(beer.beer_name),
    brewery_id: num(brewery.brewery_id),
    brewery_name: str(brewery.brewery_name),
    beer_style: str(beer.beer_style),
    abv: num(beer.beer_abv),
    rating: rating !== null && rating > 0 ? rating : null,
    had_count: num(c.count),
    first_had: normaliseDate(c.first_created_at ?? c.first_had),
    last_had: normaliseDate(c.recent_created_at ?? c.first_created_at),
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
  `CREATE TABLE IF NOT EXISTS distinct_beers (
     username     TEXT NOT NULL,
     bid          INTEGER NOT NULL,
     beer_name    TEXT,
     brewery_id   INTEGER,
     brewery_name TEXT,
     beer_style   TEXT,
     abv          REAL,
     rating       REAL,
     had_count    INTEGER,
     first_had    TEXT,
     last_had     TEXT,
     PRIMARY KEY (username, bid)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_distinct_user_brewery ON distinct_beers(username, brewery_id)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
     username           TEXT PRIMARY KEY,
     oldest_max_id      INTEGER,
     newest_checkin_id  INTEGER,
     catchup_max_id     INTEGER,
     last_synced_at     TEXT,
     backfill_complete  INTEGER NOT NULL DEFAULT 0,
     total_checkins     INTEGER,
     checkins_truncated INTEGER NOT NULL DEFAULT 0,
     beers_offset       INTEGER,
     beers_total        INTEGER,
     beers_complete     INTEGER NOT NULL DEFAULT 0
   )`,
];

/** Columns added after the initial release, each applied idempotently on open. */
export const MIGRATIONS = [
  'ALTER TABLE sync_state ADD COLUMN catchup_max_id INTEGER',
  'ALTER TABLE sync_state ADD COLUMN checkins_truncated INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_state ADD COLUMN beers_offset INTEGER',
  'ALTER TABLE sync_state ADD COLUMN beers_total INTEGER',
  'ALTER TABLE sync_state ADD COLUMN beers_complete INTEGER NOT NULL DEFAULT 0',
];

/**
 * The cache logic over a synchronous {@link SqlDriver}. Usernames are keyed
 * case-insensitively via a lowercased key so `Mer1331` and `mer1331` share one
 * cache; stored rows keep whatever casing they arrived with in other fields.
 */
export class CheckinStoreCore {
  constructor(private readonly db: SqlDriver) {
    for (const stmt of SCHEMA_STATEMENTS) this.db.execScript(stmt);
    // Forward-compat for a table created before a column existed; each ADD COLUMN
    // throws harmlessly if the column is already present.
    for (const mig of MIGRATIONS) {
      try {
        this.db.execScript(mig);
      } catch {
        /* column already exists */
      }
    }
  }

  /**
   * Upsert real check-in rows (dedupe on checkin_id) in one transaction; return
   * the NET number of newly-inserted rows.
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
          r.checkin_id, key, r.bid, r.beer_name, r.brewery_id, r.brewery_name, r.beer_style,
          r.abv, r.rating, r.comment, r.venue_id, r.venue_name, r.created_at,
        ]);
      }
    });
    return this.cachedCount(username) - before;
  }

  /** Upsert distinct-beer rows (dedupe on username+bid); return the NET new count. */
  upsertDistinctBeers(username: string, rows: DistinctBeerRow[]): number {
    if (rows.length === 0) return 0;
    const key = username.toLowerCase();
    const before = this.distinctBeersCount(username);
    const sql = `
      INSERT INTO distinct_beers
        (username, bid, beer_name, brewery_id, brewery_name, beer_style, abv, rating, had_count, first_had, last_had)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, bid) DO UPDATE SET
        beer_name=excluded.beer_name, brewery_id=excluded.brewery_id, brewery_name=excluded.brewery_name,
        beer_style=excluded.beer_style, abv=excluded.abv, rating=excluded.rating,
        had_count=excluded.had_count, first_had=excluded.first_had, last_had=excluded.last_had`;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(sql, [
          key, r.bid, r.beer_name, r.brewery_id, r.brewery_name, r.beer_style, r.abv,
          r.rating, r.had_count, r.first_had, r.last_had,
        ]);
      }
    });
    return this.distinctBeersCount(username) - before;
  }

  /** Total cached check-in rows for a user. */
  cachedCount(username: string): number {
    const row = this.db.get('SELECT COUNT(*) AS n FROM checkins WHERE username = ?', [username.toLowerCase()]);
    return Number(row?.n ?? 0);
  }

  /** Distinct beers cached via user/beers (the has-had coverage metric). */
  distinctBeersCount(username: string): number {
    const row = this.db.get('SELECT COUNT(*) AS n FROM distinct_beers WHERE username = ?', [username.toLowerCase()]);
    return Number(row?.n ?? 0);
  }

  /** Distinct bids appearing in the checkins table. */
  checkinsBeerCount(username: string): number {
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
      checkins_truncated: Number(row.checkins_truncated) === 1,
      beers_offset: num(row.beers_offset),
      beers_total: num(row.beers_total),
      beers_complete: Number(row.beers_complete) === 1,
    };
  }

  /**
   * Insert-or-merge sync state. Only keys PRESENT in `patch` are written, so an
   * explicit `null` (e.g. clearing a cursor) overrides the stored value — a `??`
   * merge could not do that.
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
      checkins_truncated: pick('checkins_truncated', false),
      beers_offset: pick('beers_offset', null),
      beers_total: pick('beers_total', null),
      beers_complete: pick('beers_complete', false),
    };
    this.db.run(
      `INSERT INTO sync_state
         (username, oldest_max_id, newest_checkin_id, catchup_max_id, last_synced_at, backfill_complete, total_checkins, checkins_truncated, beers_offset, beers_total, beers_complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         oldest_max_id=excluded.oldest_max_id, newest_checkin_id=excluded.newest_checkin_id,
         catchup_max_id=excluded.catchup_max_id, last_synced_at=excluded.last_synced_at,
         backfill_complete=excluded.backfill_complete, total_checkins=excluded.total_checkins,
         checkins_truncated=excluded.checkins_truncated, beers_offset=excluded.beers_offset,
         beers_total=excluded.beers_total, beers_complete=excluded.beers_complete`,
      [
        key, next.oldest_max_id, next.newest_checkin_id, next.catchup_max_id, next.last_synced_at,
        next.backfill_complete ? 1 : 0, next.total_checkins, next.checkins_truncated ? 1 : 0,
        next.beers_offset, next.beers_total, next.beers_complete ? 1 : 0,
      ],
    );
  }

  /**
   * Has the user had this beer? Consults BOTH sources — a hit in either the
   * check-ins table or the distinct-beers table counts as had. `count` prefers
   * the authoritative user/beers `had_count` per beer, falling back to the number
   * of cached check-ins; dates/ratings merge across both. `matches` are the
   * detailed check-ins only (the distinct-beers source has no per-check-in rows).
   */
  hasHad(username: string, opts: { bid?: number; beerName?: string }): HasHadResult {
    const key = username.toLowerCase();
    const cClause = ['username = ?'];
    const cParams: SqlParam[] = [key];
    const bClause = ['username = ?'];
    const bParams: SqlParam[] = [key];
    if (opts.bid !== undefined) {
      cClause.push('bid = ?');
      cParams.push(opts.bid);
      bClause.push('bid = ?');
      bParams.push(opts.bid);
    }
    if (opts.beerName !== undefined) {
      const like = `%${escapeLike(opts.beerName)}%`;
      cClause.push('beer_name LIKE ? COLLATE NOCASE');
      cParams.push(like);
      bClause.push('beer_name LIKE ? COLLATE NOCASE');
      bParams.push(like);
    }
    const cWhere = cClause.join(' AND ');
    const bWhere = bClause.join(' AND ');

    // Per-beer counts: number of cached check-ins per bid, and the authoritative
    // times-had per bid from user/beers.
    const perBid = new Map<number | string, number>();
    for (const r of this.db.all(`SELECT bid, COUNT(*) AS c FROM checkins WHERE ${cWhere} GROUP BY bid`, cParams)) {
      perBid.set((r.bid as number) ?? 'null', Number(r.c));
    }
    let beersRows = 0;
    let beersBest: number | null = null;
    let beersLast: string | null = null;
    for (const r of this.db.all(
      `SELECT bid, had_count, rating, last_had, first_had FROM distinct_beers WHERE ${bWhere}`,
      bParams,
    )) {
      beersRows++;
      const bid = r.bid as number;
      const hc = num(r.had_count);
      // Prefer the user/beers count; else keep the check-in-derived count; else 1.
      perBid.set(bid, hc ?? perBid.get(bid) ?? 1);
      const rating = num(r.rating);
      if (rating !== null && (beersBest === null || rating > beersBest)) beersBest = rating;
      const last = str(r.last_had) ?? str(r.first_had);
      if (last && (beersLast === null || last > beersLast)) beersLast = last;
    }

    const cAgg = this.db.get(
      `SELECT COUNT(*) AS n, MAX(rating) AS best, MAX(created_at) AS last FROM checkins WHERE ${cWhere}`,
      cParams,
    );
    const checkinRows = Number(cAgg?.n ?? 0);
    const matches = this.db.all(
      `SELECT checkin_id, bid, beer_name, rating, venue_name, created_at
       FROM checkins WHERE ${cWhere} ORDER BY created_at DESC, checkin_id DESC LIMIT 25`,
      cParams,
    ) as HasHadResult['matches'];

    let count = 0;
    for (const v of perBid.values()) count += v;
    const bestCandidates = [num(cAgg?.best), beersBest].filter((x): x is number => x !== null);
    const lastCandidates = [str(cAgg?.last), beersLast].filter((x): x is string => x !== null);
    const sources: Array<'checkins' | 'beers'> = [];
    if (checkinRows > 0) sources.push('checkins');
    if (beersRows > 0) sources.push('beers');
    return {
      had: checkinRows > 0 || beersRows > 0,
      count,
      last_date: lastCandidates.length ? lastCandidates.reduce((a, b) => (a > b ? a : b)) : null,
      best_rating: bestCandidates.length ? Math.max(...bestCandidates) : null,
      sources,
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
        ? 'created_at ASC, checkin_id ASC'
        : filters.sort === 'highest_rated'
          ? 'rating DESC, created_at DESC'
          : filters.sort === 'lowest_rated'
            ? 'rating ASC, created_at DESC'
            : 'created_at DESC, checkin_id DESC';
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
  async upsertDistinctBeers(username: string, rows: DistinctBeerRow[]): Promise<number> {
    return this.core.upsertDistinctBeers(username, rows);
  }
  async cachedCount(username: string): Promise<number> {
    return this.core.cachedCount(username);
  }
  async distinctBeersCount(username: string): Promise<number> {
    return this.core.distinctBeersCount(username);
  }
  async checkinsBeerCount(username: string): Promise<number> {
    return this.core.checkinsBeerCount(username);
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
