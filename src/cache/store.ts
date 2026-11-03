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
// schema/queries back any engine: `node:sqlite` is the one that ships, and a
// different deployment can adapt another driver to the same surface. This
// module imports nothing platform-specific.

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

/**
 * Cached global beer metadata (from beer/info or search results). Keyed by bid
 * and shared across usernames — beer facts are the same for everyone. `fetched_at`
 * drives staleness so metadata is re-fetched at most every ~30 days.
 */
export interface BeerMeta {
  bid: number;
  name: string | null;
  brewery: string | null;
  brewery_id: number | null;
  style: string | null;
  parent_style: string | null;
  abv: number | null;
  ibu: number | null;
  weighted_rating_score: number | null;
  rating_score: number | null;
  rating_count: number | null;
  fetched_at: string | null;
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
  /**
   * How far short of `beers_total` the cache may legitimately sit (beers
   * total_count counts but never lists). A shortfall LARGER than this means the
   * offset-paged sync skipped beers, and triggers a rescan from the top.
   */
  beers_accepted_gap: number;
  /**
   * Non-null while a coverage rescan of user/beers is in progress: the shortfall
   * at which the rescan may stop early (the gap it is trying to close back to).
   */
  beers_rescan_target: number | null;
  /**
   * Fairness flag for the max_pages=1 edge, where the shared per-call page budget
   * (see sync.ts) can only fund ONE of the catch-up / backfill phases per run.
   * Records whether the last such tie went to the backfill phase, so the next
   * tie goes to catch-up and neither phase is permanently starved.
   */
  served_backfill_last: boolean;
}

/** Global venue facts (the `venues` table), from user/venues items. Shared across users. */
export interface VenueRow {
  venue_id: number;
  name: string | null;
  category: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  /** 1/0, or null when Untappd didn't say. */
  is_verified: number | null;
}

/** One user's visit summary at one venue (the `user_venues` table). */
export interface UserVenueRow {
  venue_id: number;
  first_visit: string | null;
  first_checkin_id: number | null;
  recent_visit: string | null;
  recent_checkin_id: number | null;
  total_count: number | null;
}

/** A mapped user/venues item: the shared venue facts plus this user's visits there. */
export interface UserVenueItem {
  venue: VenueRow;
  visit: UserVenueRow;
}

/** Per-user, per-list offset cursor (the `list_sync_state` table). */
export interface ListSyncState {
  username: string;
  list: string;
  next_offset: number | null;
  total_count: number | null;
  complete: boolean;
  last_synced_at: string | null;
}

/**
 * One has-visited lookup. `venue_ids` matches exactly and is UNIONED with the
 * name/geo match; `name` (+ optional `city`/`state`) and `lat`/`lng`
 * (+ `radius_m`, default 150) are ANDed when both are given.
 */
export interface VenueQuery {
  venue_ids?: number[];
  name?: string;
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  radius_m?: number;
}

/** A cached venue the user has visited, as {@link CacheStore.findVisitedVenues} returns it. */
export interface VisitedVenue extends VenueRow, UserVenueRow {
  /** True for Untappd's "… (duplicate of …)" venues. */
  is_duplicate: boolean;
  /** Metres from the query point, when the query had lat/lng. */
  distance_m?: number;
}

/** Default radius for a lat/lng has-visited query. */
export const DEFAULT_VISIT_RADIUS_M = 150;

/** The per-bid verdict {@link CacheStore.hasHadMany} returns (no per-check-in matches). */
export type HasHadVerdict = Omit<HasHadResult, 'matches'>;

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
  /** Batch has-had by bid; every requested bid gets an entry. */
  hasHadMany(username: string, bids: number[]): Promise<Map<number, HasHadVerdict>>;
  query(username: string, filters: QueryFilters): Promise<CheckinRow[]>;
  /** Read cached metadata for the given bids (only those present are returned). */
  getBeerMeta(bids: number[]): Promise<BeerMeta[]>;
  /** Upsert cached beer metadata (dedupe on bid). */
  upsertBeerMeta(rows: BeerMeta[]): Promise<void>;
  /**
   * Delete everything cached for one user (check-ins, distinct beers, sync
   * state) and return how many rows each table lost. Shared `beer_meta` is
   * global beer facts, not user data, and is kept.
   */
  forgetUser(username: string): Promise<ForgetResult>;
  /** Cached distinct-beer rows for the given bids (only those present). */
  getDistinctBeers(username: string, bids: number[]): Promise<DistinctBeerRow[]>;
  /** Read cached menu-line resolutions by key (only those present are returned). */
  getResolutions(keys: string[]): Promise<ItemResolution[]>;
  /** Upsert menu-line resolutions (dedupe on key). */
  upsertResolutions(rows: ItemResolution[]): Promise<void>;
  /**
   * Upsert user/venues items: the shared `venues` facts and this user's
   * `user_venues` rows, in one transaction. Returns how many visit rows were NEW
   * and how many existing ones CHANGED (recent_visit or total_count).
   */
  upsertUserVenues(username: string, items: UserVenueItem[]): Promise<{ added: number; updated: number }>;
  /** Cached visit rows for the given venue ids (only those present). */
  getUserVenueVisits(username: string, venueIds: number[]): Promise<UserVenueRow[]>;
  /** How many venues the user has in `user_venues`. */
  userVenuesCount(username: string): Promise<number>;
  /** Shared venue facts (the `venues` table) for the given ids — only those cached. */
  getVenues(venueIds: number[]): Promise<VenueRow[]>;
  getListState(username: string, list: string): Promise<ListSyncState | undefined>;
  /** Insert-or-merge a list cursor; only keys present in `patch` are written. */
  setListState(username: string, list: string, patch: Partial<Omit<ListSyncState, 'username' | 'list'>>): Promise<void>;
  /** Cached venues the user has visited that match `q`, most-visited first. */
  findVisitedVenues(username: string, q: VenueQuery): Promise<VisitedVenue[]>;
  /** Schema version, per-user coverage and table sizes. */
  stats(): Promise<CacheStats>;
  /** A brewery's cached beer list, or undefined if none is cached. */
  getBreweryBeerList(breweryId: number): Promise<BreweryBeerList | undefined>;
  /** Store one fetched beer_list page (restart drops the old snapshot first). */
  saveBreweryBeerPage(page: BreweryBeerPage): Promise<void>;
  /** A cached response by key, or undefined. */
  getCachedResponse(key: string): Promise<CachedResponse | undefined>;
  /** Store a response (and prune entries older than the retention window). */
  putCachedResponse(key: string, kind: string, data: unknown, fetchedAt: string): Promise<void>;
  /** Upsert wishlist rows stamped with this sync pass; returns how many were NEW. */
  upsertWishlist(username: string, rows: WishlistRow[], passStamp: string): Promise<number>;
  /** Delete wishlist rows not seen in the pass stamped `passStamp`; returns how many. */
  pruneWishlist(username: string, passStamp: string): Promise<number>;
  wishlistCount(username: string): Promise<number>;
  /** The user's cached wishlist; restricted to `bids` when given. */
  getWishlist(username: string, bids?: number[]): Promise<WishlistRow[]>;
  /** Upsert liked-brewery rows stamped with this sync pass; returns how many were NEW. */
  upsertBreweryLikes(username: string, rows: BreweryLikeRow[], passStamp: string): Promise<number>;
  /** Delete liked-brewery rows not seen in the pass stamped `passStamp`; returns how many. */
  pruneBreweryLikes(username: string, passStamp: string): Promise<number>;
  breweryLikesCount(username: string): Promise<number>;
  /** The user's cached Untappd brewery likes, newest like first; restricted to `breweryIds` when given. */
  getBreweryLikes(username: string, breweryIds?: number[]): Promise<BreweryLikeRow[]>;
  /** The user's brewery-likes mirror coverage; null if never synced. */
  breweryLikesCoverage(username: string): Promise<BreweryLikesCoverage | null>;
  /**
   * The user's cached venues' first/recent check-ins with no `venue_drinks` row
   * yet (a 404 tombstone counts as a row), most-visited venues first, a check-in
   * id listed once. Restricted to `venueIds` / `which` when given.
   */
  venueDrinkCandidates(username: string, opts?: { venueIds?: number[]; which?: 'both' | 'first' | 'recent' }): Promise<VenueDrinkCandidate[]>;
  /**
   * Store fetched visit drinks. A row with `bid` and `beer_name` both null is a
   * tombstone: the check-in is gone or private, so it is never asked for again.
   */
  upsertVenueDrinks(username: string, rows: VenueDrinkRow[], fetchedAt: string): Promise<void>;
  /** Cached drinks (tombstones excluded) at the given venues, newest first. */
  getVenueDrinks(username: string, venueIds: number[]): Promise<VenueDrinkRow[]>;
  /**
   * Add (or update the note of) a LOCAL manual favorite — never written to
   * Untappd. `note: undefined` keeps an existing note; created_at is kept on update.
   */
  addFavorite(username: string, kind: FavoriteKind, id: number, note: string | null | undefined, createdAt: string): Promise<AddFavoriteResult>;
  /** Remove a manual favorite; false when there was none. */
  removeFavorite(username: string, kind: FavoriteKind, id: number): Promise<boolean>;
  /** The user's manual favorites (newest first), named from what the cache knows. */
  getManualFavorites(username: string, opts?: { kind?: FavoriteKind; ids?: number[] }): Promise<ManualFavoriteRow[]>;
  /**
   * Per-brewery aggregates over the user's distinct beers (both has-had
   * sources): beers had, how many the user rated, and their average rating.
   */
  breweryHadStats(username: string, breweryIds?: number[]): Promise<BreweryHadStats[]>;
  /**
   * Per-beer best rating and times had (both sources, same merge as hasHadMany).
   * With `bids`, those beers the user has had; without, only beers rated at least
   * `minRating` OR had at least `minTimesHad` times.
   */
  beerHadStats(username: string, opts: { bids?: number[]; minRating?: number; minTimesHad?: number }): Promise<BeerHadStats[]>;
  /** The user's visited venues (with names), restricted to `venueIds` and/or a minimum total_count. */
  venueVisitStats(username: string, opts: { venueIds?: number[]; minCheckins?: number }): Promise<VisitedVenue[]>;
  /** Append API call observations to the shared log (see src/ratelimit.ts). Optional for non-file backends. */
  recordApiCalls?(rows: ApiCallObservation[]): Promise<void>;
  /** Logged API calls at or after `sinceMs` (epoch ms), oldest first. */
  recentApiCalls?(sinceMs: number): Promise<ApiCallObservation[]>;
}

/** Mirrors src/ratelimit.ts's ApiCallObservation (declared here so this module imports nothing). */
export interface ApiCallObservation {
  at: number;
  status: number;
  remaining: number | null;
  limit: number | null;
  reset_at: number | null;
  retry_after_s: number | null;
}

/**
 * A cached menu-line → beer resolution (see src/menu/). Keyed by the
 * NORMALISED line plus the venue city it was scored against, and shared across
 * usernames: what "JACKALOPE FENNARIO IPA" means doesn't depend on who drinks it.
 */
export interface ItemResolution {
  key: string;
  /** The raw menu line that first produced this resolution (for display/debugging). */
  item: string;
  status: 'resolved' | 'possible' | 'unresolved';
  bid: number | null;
  /** JSON payload: the chosen beer for `resolved`, candidate list for `possible`, reason for `unresolved`. */
  data: string | null;
  resolved_at: string;
}

/**
 * One beer of a brewery's cached beer list (`brewery_beers`): GLOBAL facts only.
 * brewery/beer_list's `has_had` / `total_user_count` describe the AUTHENTICATED
 * account, not whoever a tool is asked about, so they are never stored.
 */
export interface BreweryBeerRow {
  brewery_id: number;
  bid: number;
  beer_name: string | null;
  style: string | null;
  abv: number | null;
  /** IBU as brewery/beer_list reports it (null when absent, or cached before schema v6). */
  ibu: number | null;
  rating_score: number | null;
  rating_count: number | null;
  checkin_count: number | null;
  in_production: boolean | null;
  /** 0-based position in Untappd's default (popularity) order, when fetched in it. */
  popularity_rank: number | null;
  fetched_at: string;
}

/** A brewery's cached beer list: header + rows (popularity order, unranked rows last). */
export interface BreweryBeerList {
  brewery_id: number;
  brewery_name: string | null;
  total_count: number | null;
  /** How many beers from the top of the popularity order are cached contiguously. */
  ranked_count: number;
  /** When the current snapshot was started — the TTL clock. */
  fetched_at: string;
  beers: BreweryBeerRow[];
}

/** One fetched brewery/beer_list page to store (see {@link CacheStore.saveBreweryBeerPage}). */
export interface BreweryBeerPage {
  brewery_id: number;
  brewery_name: string | null;
  total_count: number | null;
  rows: BreweryBeerRow[];
  /** The page's offset when fetched in the default (popularity) order; null for any other sort. */
  ranked_offset: number | null;
  /** Items the page held (mapped or not) — advances the ranked prefix. */
  item_count: number;
  /** Drop the brewery's old rows and restart the TTL clock (stale or refresh). */
  restart: boolean;
  fetched_at: string;
}

/** One beer on a user's wishlist (`wishlist`). */
export interface WishlistRow {
  bid: number;
  beer_name: string | null;
  brewery_id: number | null;
  brewery_name: string | null;
  style: string | null;
  abv: number | null;
  added_at: string | null;
}

/**
 * One brewery a user "likes" on Untappd (`brewery_likes`, from user/brewerylikes —
 * the app's "following"). Unlike brewery/info's follow_status, this list is the
 * NAMED user's, so it is safe to report for anyone.
 */
export interface BreweryLikeRow {
  brewery_id: number;
  brewery_name: string | null;
  brewery_type: string | null;
  country: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  /** When the user liked it (the item's created_at). */
  liked_at: string | null;
}

/** What a user drank on one visit to a venue (`venue_drinks`), from checkin/view. */
export interface VenueDrinkRow {
  venue_id: number;
  checkin_id: number;
  bid: number | null;
  beer_name: string | null;
  brewery_id: number | null;
  brewery_name: string | null;
  created_at: string | null;
}

/** A user_venues first/recent check-in whose drink is not cached yet. */
export interface VenueDrinkCandidate {
  venue_id: number;
  checkin_id: number;
  kind: 'first' | 'recent';
}

/** A short-TTL cached API response (`response_cache`). */
export interface CachedResponse {
  key: string;
  kind: string;
  data: unknown;
  fetched_at: string;
}

/** Per-user wishlist mirror coverage (cache_status). */
export interface WishlistCoverage {
  cached: number;
  total: number | null;
  complete: boolean;
  next_offset: number | null;
  last_synced_at: string | null;
}

/** Per-user Untappd brewery-likes mirror coverage (cache_status). */
export interface BreweryLikesCoverage {
  cached: number;
  total: number | null;
  /** A full pass has finished: the cache mirrors the likes as of last_synced_at. */
  complete: boolean;
  percent: number | null;
  next_offset: number | null;
  last_synced_at: string | null;
}

/** Per-user row of {@link CacheStats}. */
export interface CacheUserStats {
  username: string;
  cached_distinct_beers: number;
  total_distinct_beers: number | null;
  cached_checkins: number;
  coverage_complete: boolean;
  beers_offset: number | null;
  last_synced_at: string | null;
  /** user/venues coverage; null when the user's venue history was never synced. */
  venues: VenueCoverage | null;
  /** Wishlist mirror coverage; null when the user's wishlist was never synced. */
  wishlist: WishlistCoverage | null;
  /** Untappd brewery-likes coverage; null when the user's likes were never synced. */
  brewery_likes: BreweryLikesCoverage | null;
}

/** user/venues coverage for one user (cache_status, has_visited freshness). */
export interface VenueCoverage {
  cached_venues: number;
  total_venues: number | null;
  /** The whole list is cached AND no incremental refresh is unfinished. */
  complete: boolean;
  /** An incremental refresh was cut short; changes below its cursor may be missing. */
  refresh_in_progress: boolean;
  percent: number | null;
  next_offset: number | null;
  last_synced_at: string | null;
}

/** Whole-cache diagnostics for untappd_cache_status. */
export interface CacheStats {
  schema_version: number;
  users: CacheUserStats[];
  resolution_cache_entries: number;
  beer_meta_entries: number;
  /** Rows in the shared `venues` table. */
  venue_entries: number;
  /** Breweries with a cached beer list. */
  brewery_lists: number;
  /** Short-TTL cached responses (venue menus / activity). */
  response_cache_entries: number;
}

/** Rows removed by {@link CacheStore.forgetUser}, per table. */
/** What a favorite points at. */
export type FavoriteKind = 'beer' | 'brewery' | 'venue';
export const FAVORITE_KINDS = ['beer', 'brewery', 'venue'] as const;

/** One manual favorite (`favorites` table), plus a display name when the cache knows one. */
export interface ManualFavoriteRow {
  kind: FavoriteKind;
  id: number;
  note: string | null;
  created_at: string;
  name: string | null;
}

export interface AddFavoriteResult {
  /** False when the favorite already existed (its note may have been updated). */
  added: boolean;
  note: string | null;
  created_at: string;
}

/** Per-brewery has-had aggregate (see {@link CacheStore.breweryHadStats}). */
export interface BreweryHadStats {
  brewery_id: number;
  brewery_name: string | null;
  beers: number;
  rated_beers: number;
  /** Mean of the user's ratings over rated beers only; null when none is rated. */
  avg_rating: number | null;
}

/** Per-beer has-had aggregate (see {@link CacheStore.beerHadStats}). */
export interface BeerHadStats {
  bid: number;
  beer_name: string | null;
  brewery_id: number | null;
  brewery_name: string | null;
  /** Best rating across both sources (unrated = null). */
  rating: number | null;
  times_had: number;
}

export type ForgetResult = Record<(typeof PER_USER_TABLES)[number], number>;

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
/** A number, or a numeric string (coordinates sometimes arrive as strings). */
function numLoose(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() !== '') return num(Number(v));
  return num(v);
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

/**
 * Normalise a raw `/user/venues` item to the shared venue facts plus the user's
 * visit summary. Dates become ISO-8601 UTC (sortable, comparable across syncs).
 * Returns null without a venue id (Untappd sends `venue: []` for none).
 */
export function mapUserVenueItem(_username: string, item: unknown): UserVenueItem | null {
  const c = asDict(item);
  const v = asDict(c.venue);
  const venue_id = num(v.venue_id);
  if (venue_id === null) return null;
  const loc = asDict(v.location);
  const verified = v.is_verified;
  return {
    venue: {
      venue_id,
      name: str(v.venue_name),
      category: str(v.primary_category),
      address: str(loc.venue_address),
      city: str(loc.venue_city),
      state: str(loc.venue_state),
      country: str(loc.venue_country),
      lat: numLoose(loc.lat),
      lng: numLoose(loc.lng),
      is_verified: typeof verified === 'boolean' || typeof verified === 'number' ? (verified ? 1 : 0) : null,
    },
    visit: {
      venue_id,
      first_visit: normaliseDate(c.first_visit),
      first_checkin_id: num(c.first_checkin_id),
      recent_visit: normaliseDate(c.recent_visit),
      recent_checkin_id: num(c.recent_checkin_id),
      total_count: num(c.total_count),
    },
  };
}

/**
 * Map one brewery/beer_list item to a {@link BreweryBeerRow}. Takes only the
 * global facts: the item's `has_had` / `total_user_count` are the AUTHENTICATED
 * account's and are deliberately dropped. Returns null without a bid.
 */
export function mapBreweryBeerItem(
  breweryId: number,
  item: unknown,
  fetchedAt: string,
  popularityRank: number | null,
): BreweryBeerRow | null {
  const i = asDict(item);
  const b = asDict(i.beer);
  const bid = num(b.bid);
  if (bid === null) return null;
  const inProd = num(b.is_in_production);
  return {
    brewery_id: breweryId,
    bid,
    beer_name: str(b.beer_name),
    style: str(b.beer_style),
    abv: num(b.beer_abv),
    ibu: num(b.beer_ibu),
    rating_score: num(b.rating_score),
    rating_count: num(b.rating_count),
    checkin_count: num(i.total_count),
    in_production: inProd === null ? null : inProd !== 0,
    popularity_rank: popularityRank,
    fetched_at: fetchedAt,
  };
}

/** Map one user/wishlist item; null without a bid. */
export function mapWishlistItem(item: unknown): WishlistRow | null {
  const i = asDict(item);
  const b = asDict(i.beer);
  const bid = num(b.bid);
  if (bid === null) return null;
  const brw = asDict(i.brewery);
  return {
    bid,
    beer_name: str(b.beer_name),
    brewery_id: num(brw.brewery_id),
    brewery_name: str(brw.brewery_name),
    style: str(b.beer_style),
    abv: num(b.beer_abv),
    added_at: normaliseDate(i.created_at),
  };
}

/** Map one user/brewerylikes item; null without a brewery_id. */
export function mapBreweryLikeItem(item: unknown): BreweryLikeRow | null {
  const i = asDict(item);
  const b = asDict(i.brewery);
  const id = num(b.brewery_id);
  if (id === null) return null;
  const loc = asDict(b.location);
  return {
    brewery_id: id,
    brewery_name: str(b.brewery_name),
    brewery_type: str(b.brewery_type),
    country: str(b.country_name),
    city: str(loc.brewery_city),
    state: str(loc.brewery_state),
    lat: num(loc.lat),
    lng: num(loc.lng),
    liked_at: normaliseDate(i.created_at),
  };
}

/**
 * Normalise a beer object (from beer/info's `beer`, or a search/list item's
 * `beer` with a sibling `brewery`) to {@link BeerMeta}. `fetchedAt` stamps when
 * it was read so staleness can be judged. Returns null without a bid.
 */
export function beerMetaFrom(beer: unknown, brewery: unknown, fetchedAt: string): BeerMeta | null {
  const b = asDict(beer);
  const bid = num(b.bid);
  if (bid === null) return null;
  const brw = asDict(brewery ?? b.brewery);
  return {
    bid,
    name: str(b.beer_name),
    brewery: str(brw.brewery_name),
    brewery_id: num(brw.brewery_id),
    style: str(b.beer_style),
    parent_style: str(b.parent_style_name),
    abv: num(b.beer_abv),
    ibu: num(b.beer_ibu),
    weighted_rating_score: num(b.weighted_rating_score),
    rating_score: num(b.rating_score),
    rating_count: num(b.rating_count),
    fetched_at: fetchedAt,
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
  `CREATE TABLE IF NOT EXISTS beer_meta (
     bid                   INTEGER PRIMARY KEY,
     name                  TEXT,
     brewery               TEXT,
     brewery_id            INTEGER,
     style                 TEXT,
     parent_style          TEXT,
     abv                   REAL,
     ibu                   REAL,
     weighted_rating_score REAL,
     rating_score          REAL,
     rating_count          INTEGER,
     fetched_at            TEXT
   )`,
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
     beers_complete     INTEGER NOT NULL DEFAULT 0,
     served_backfill_last INTEGER NOT NULL DEFAULT 0,
     beers_accepted_gap INTEGER NOT NULL DEFAULT 0,
     beers_rescan_target INTEGER
   )`,
];

/**
 * Columns added to the v1 tables before the schema was versioned. A database
 * at user_version 0 may predate any of them, so each is applied idempotently
 * (ADD COLUMN throws harmlessly when the column already exists).
 */
export const MIGRATIONS = [
  'ALTER TABLE sync_state ADD COLUMN catchup_max_id INTEGER',
  'ALTER TABLE sync_state ADD COLUMN checkins_truncated INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_state ADD COLUMN beers_offset INTEGER',
  'ALTER TABLE sync_state ADD COLUMN beers_total INTEGER',
  'ALTER TABLE sync_state ADD COLUMN beers_complete INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_state ADD COLUMN served_backfill_last INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_state ADD COLUMN beers_accepted_gap INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_state ADD COLUMN beers_rescan_target INTEGER',
];

/**
 * Forward-only, versioned migrations, tracked in SQLite's `PRAGMA user_version`.
 * Version 1 is the baseline (SCHEMA_STATEMENTS + the legacy MIGRATIONS above);
 * every later change is appended here with the next version number and is
 * ADDITIVE — a migration never drops or rewrites user rows, so upgrading can't
 * silently wipe a cache that took an hour of rate-limited calls to fill.
 */
export const VERSIONED_MIGRATIONS: ReadonlyArray<{ version: number; statements: string[] }> = [
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS item_resolutions (
         key         TEXT PRIMARY KEY,
         item        TEXT NOT NULL,
         status      TEXT NOT NULL,
         bid         INTEGER,
         data        TEXT,
         resolved_at TEXT NOT NULL
       )`,
    ],
  },
  {
    // untappd_cache_query's default (and date-range) ordering.
    version: 3,
    statements: ['CREATE INDEX IF NOT EXISTS idx_checkins_user_created ON checkins(username, created_at)'],
  },
  {
    // Venue history, list syncs, TTL caches, favorites and the API call log.
    // New tables only — nothing existing is altered.
    version: 4,
    statements: [
      // Global venue facts from user/venues (and venue/info), shared across users.
      `CREATE TABLE IF NOT EXISTS venues (
         venue_id    INTEGER PRIMARY KEY,
         name        TEXT,
         category    TEXT,
         address     TEXT,
         city        TEXT,
         state       TEXT,
         country     TEXT,
         lat         REAL,
         lng         REAL,
         is_verified INTEGER,
         updated_at  TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_venues_city ON venues(city COLLATE NOCASE)`,
      `CREATE INDEX IF NOT EXISTS idx_venues_lat_lng ON venues(lat, lng)`,
      // One row per (user, venue) from user/venues: the user's visit summary there.
      `CREATE TABLE IF NOT EXISTS user_venues (
         username          TEXT NOT NULL,
         venue_id          INTEGER NOT NULL,
         first_visit       TEXT,
         first_checkin_id  INTEGER,
         recent_visit      TEXT,
         recent_checkin_id INTEGER,
         total_count       INTEGER,
         synced_at         TEXT,
         PRIMARY KEY (username, venue_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_user_venues_recent ON user_venues(username, recent_visit)`,
      // Resumable cursor + reported total for offset-paged per-user lists
      // (list = 'venues' | 'wishlist' | …). Kept out of sync_state so each list
      // owns its own bookkeeping.
      `CREATE TABLE IF NOT EXISTS list_sync_state (
         username       TEXT NOT NULL,
         list           TEXT NOT NULL,
         next_offset    INTEGER,
         total_count    INTEGER,
         complete       INTEGER NOT NULL DEFAULT 0,
         last_synced_at TEXT,
         PRIMARY KEY (username, list)
       )`,
      // brewery/beer_list results, per brewery, with a TTL on the list as a whole.
      // The response's have_had reflects the AUTHENTICATED account, so it is not stored.
      // fetched_at is when the current snapshot STARTED (its TTL clock);
      // ranked_count is how many beers from the top of Untappd's default
      // (popularity) order are cached contiguously.
      `CREATE TABLE IF NOT EXISTS brewery_beer_lists (
         brewery_id   INTEGER PRIMARY KEY,
         brewery_name TEXT,
         total_count  INTEGER,
         ranked_count INTEGER NOT NULL DEFAULT 0,
         fetched_at   TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS brewery_beers (
         brewery_id    INTEGER NOT NULL,
         bid           INTEGER NOT NULL,
         beer_name     TEXT,
         style         TEXT,
         abv           REAL,
         rating_score  REAL,
         rating_count  INTEGER,
         checkin_count INTEGER,
         in_production INTEGER,
         popularity_rank INTEGER,
         fetched_at    TEXT NOT NULL,
         PRIMARY KEY (brewery_id, bid)
       )`,
      // Short-TTL raw response cache (venue menus / activity), keyed e.g. 'venue_menu:123'.
      `CREATE TABLE IF NOT EXISTS response_cache (
         key        TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         data       TEXT NOT NULL,
         fetched_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS wishlist (
         username     TEXT NOT NULL,
         bid          INTEGER NOT NULL,
         beer_name    TEXT,
         brewery_id   INTEGER,
         brewery_name TEXT,
         style        TEXT,
         abv          REAL,
         added_at     TEXT,
         synced_at    TEXT NOT NULL,
         PRIMARY KEY (username, bid)
       )`,
      // Manual favorites — local only, never written to Untappd.
      `CREATE TABLE IF NOT EXISTS favorites (
         username   TEXT NOT NULL,
         kind       TEXT NOT NULL CHECK (kind IN ('beer', 'brewery', 'venue')),
         id         INTEGER NOT NULL,
         note       TEXT,
         created_at TEXT NOT NULL,
         PRIMARY KEY (username, kind, id)
       )`,
      // What a user drank at a venue, from checkin/view of the user_venues first/recent check-ins.
      `CREATE TABLE IF NOT EXISTS venue_drinks (
         username     TEXT NOT NULL,
         venue_id     INTEGER NOT NULL,
         checkin_id   INTEGER NOT NULL,
         bid          INTEGER,
         beer_name    TEXT,
         brewery_id   INTEGER,
         brewery_name TEXT,
         created_at   TEXT,
         fetched_at   TEXT NOT NULL,
         PRIMARY KEY (username, checkin_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_venue_drinks_user_venue ON venue_drinks(username, venue_id)`,
      // Every API response's time/status/rate-limit headers (src/ratelimit.ts),
      // shared by all processes using this file. Pruned to ~2 hours.
      `CREATE TABLE IF NOT EXISTS api_calls (
         at            INTEGER NOT NULL,
         status        INTEGER NOT NULL,
         remaining     INTEGER,
         limit_hdr     INTEGER,
         reset_at      INTEGER,
         retry_after_s INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS idx_api_calls_at ON api_calls(at)`,
    ],
  },
  {
    // Untappd brewery likes (user/brewerylikes, the app's "following") — the
    // "untappd" favorite source. A new table only; nothing existing is altered.
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS brewery_likes (
         username     TEXT NOT NULL,
         brewery_id   INTEGER NOT NULL,
         brewery_name TEXT,
         brewery_type TEXT,
         country      TEXT,
         city         TEXT,
         state        TEXT,
         lat          REAL,
         lng          REAL,
         liked_at     TEXT,
         synced_at    TEXT NOT NULL,
         PRIMARY KEY (username, brewery_id)
       )`,
    ],
  },
  {
    // brewery/beer_list items carry `beer_ibu`, which the old live-only compact
    // projection returned; caching it keeps untappd_brewery_beers' compact shape
    // identical with and without the cache. Additive: rows cached before this
    // read back ibu null until the list next refreshes (7-day TTL).
    version: 6,
    statements: [`ALTER TABLE brewery_beers ADD COLUMN ibu REAL`],
  },
];

/** Tables holding one user's data, cleared by {@link CheckinStoreCore.forgetUser}. */
export const PER_USER_TABLES = [
  'checkins',
  'distinct_beers',
  'sync_state',
  'user_venues',
  'list_sync_state',
  'wishlist',
  'favorites',
  'venue_drinks',
  'brewery_likes',
] as const;

/** How long short-TTL cached responses are kept at all (longer than any TTL that can serve them). */
export const RESPONSE_CACHE_RETENTION_MS = 48 * 60 * 60 * 1000;

/** How long the persisted API call log is kept (it only needs the rolling hour). */
const API_CALL_LOG_RETENTION_MS = 2 * 60 * 60 * 1000;

/** The schema version this code writes. */
export const SCHEMA_VERSION = VERSIONED_MIGRATIONS.reduce((v, m) => Math.max(v, m.version), 1);

/**
 * The cache logic over a synchronous {@link SqlDriver}. Usernames are keyed
 * case-insensitively via a lowercased key so `Mer1331` and `mer1331` share one
 * cache; stored rows keep whatever casing they arrived with in other fields.
 */
export class CheckinStoreCore {
  private version = 0;

  constructor(private readonly db: SqlDriver) {
    this.migrate();
  }

  /**
   * Bring the schema up to {@link SCHEMA_VERSION}. Runs in ONE write
   * transaction and re-reads the version inside it, so two processes opening a
   * fresh file at once can't both apply the same step. A file written by a
   * NEWER build is left untouched (its migrations are additive, so this build's
   * queries still work) rather than "repaired" downwards.
   */
  private migrate(): void {
    this.db.transaction(() => {
      const current = Number(this.db.get('PRAGMA user_version', [])?.user_version ?? 0);
      if (current > SCHEMA_VERSION) {
        console.error(
          `[untappd-mcp] cache schema v${current} is newer than this build (v${SCHEMA_VERSION}); using it as-is.`,
        );
        this.version = current;
        return;
      }
      if (current < 1) {
        for (const stmt of SCHEMA_STATEMENTS) this.db.execScript(stmt);
        // A pre-versioning file may lack any of these columns; each ADD COLUMN
        // throws harmlessly if the column is already present.
        for (const mig of MIGRATIONS) {
          try {
            this.db.execScript(mig);
          } catch {
            /* column already exists */
          }
        }
      }
      for (const m of VERSIONED_MIGRATIONS) {
        if (m.version <= current) continue;
        for (const stmt of m.statements) {
          try {
            this.db.execScript(stmt);
          } catch (e) {
            // An ADD COLUMN step is idempotent: a file whose user_version lags
            // its real schema (e.g. reset by hand) already has the column.
            if (!/ADD COLUMN/i.test(stmt) || !/duplicate column/i.test(String((e as Error)?.message))) throw e;
          }
        }
      }
      if (current !== SCHEMA_VERSION) this.db.execScript(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.version = SCHEMA_VERSION;
    });
  }

  /** The schema version of the open database. */
  schemaVersion(): number {
    return this.version;
  }

  /**
   * Upsert real check-in rows (dedupe on checkin_id) in one transaction; return
   * the NET number of newly-inserted rows.
   */
  upsertCheckins(username: string, rows: CheckinRow[]): number {
    if (rows.length === 0) return 0;
    const key = username.toLowerCase();
    let added = 0;
    const sql = `
      INSERT INTO checkins
        (checkin_id, username, bid, beer_name, brewery_id, brewery_name, beer_style, abv, rating, comment, venue_id, venue_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkin_id) DO UPDATE SET
        username=excluded.username, bid=excluded.bid, beer_name=excluded.beer_name,
        brewery_id=excluded.brewery_id, brewery_name=excluded.brewery_name, beer_style=excluded.beer_style,
        abv=excluded.abv, rating=excluded.rating, comment=excluded.comment,
        venue_id=excluded.venue_id, venue_name=excluded.venue_name, created_at=excluded.created_at`;
    // "Net new" = ids this user didn't already have, read inside the write
    // transaction so another process's concurrent inserts can't skew it. It
    // looks up only this batch's ids; COUNT(*)-before/after scanned the user's
    // whole history on every page, which made a long backfill quadratic.
    this.db.transaction(() => {
      const ids = [...new Set(rows.map((r) => r.checkin_id))];
      const had = this.existing('checkins', 'checkin_id', key, ids);
      added = ids.filter((id) => !had.has(id)).length;
      for (const r of rows) {
        this.db.run(sql, [
          r.checkin_id, key, r.bid, r.beer_name, r.brewery_id, r.brewery_name, r.beer_style,
          r.abv, r.rating, r.comment, r.venue_id, r.venue_name, r.created_at,
        ]);
      }
    });
    return added;
  }

  /** Upsert distinct-beer rows (dedupe on username+bid); return the NET new count. */
  upsertDistinctBeers(username: string, rows: DistinctBeerRow[]): number {
    if (rows.length === 0) return 0;
    const key = username.toLowerCase();
    let added = 0;
    const sql = `
      INSERT INTO distinct_beers
        (username, bid, beer_name, brewery_id, brewery_name, beer_style, abv, rating, had_count, first_had, last_had)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, bid) DO UPDATE SET
        beer_name=excluded.beer_name, brewery_id=excluded.brewery_id, brewery_name=excluded.brewery_name,
        beer_style=excluded.beer_style, abv=excluded.abv, rating=excluded.rating,
        had_count=excluded.had_count, first_had=excluded.first_had, last_had=excluded.last_had`;
    this.db.transaction(() => {
      const bids = [...new Set(rows.map((r) => r.bid))];
      const had = this.existing('distinct_beers', 'bid', key, bids);
      added = bids.filter((b) => !had.has(b)).length;
      for (const r of rows) {
        this.db.run(sql, [
          key, r.bid, r.beer_name, r.brewery_id, r.brewery_name, r.beer_style, r.abv,
          r.rating, r.had_count, r.first_had, r.last_had,
        ]);
      }
    });
    return added;
  }

  /** Which of `ids` already exist in `table.column` for this (lowercased) user. */
  private existing(table: 'checkins' | 'distinct_beers', column: 'checkin_id' | 'bid', key: string, ids: number[]): Set<number> {
    const found = new Set<number>();
    for (const part of chunks(ids)) {
      const rows = this.db.all(
        `SELECT ${column} AS id FROM ${table} WHERE username = ? AND ${column} IN (${part.map(() => '?').join(', ')})`,
        [key, ...part],
      );
      for (const r of rows) found.add(Number(r.id));
    }
    return found;
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

  /**
   * Upsert user/venues items in one transaction: the shared venue facts (the
   * latest copy wins) and this user's visit rows. "added"/"updated" are taken
   * against the rows already cached for just this batch's venue ids.
   */
  upsertUserVenues(username: string, items: UserVenueItem[], now = new Date().toISOString()): { added: number; updated: number } {
    if (items.length === 0) return { added: 0, updated: 0 };
    const key = username.toLowerCase();
    const venueSql = `
      INSERT INTO venues (venue_id, name, category, address, city, state, country, lat, lng, is_verified, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(venue_id) DO UPDATE SET
        name=excluded.name, category=excluded.category, address=excluded.address, city=excluded.city,
        state=excluded.state, country=excluded.country, lat=excluded.lat, lng=excluded.lng,
        is_verified=excluded.is_verified, updated_at=excluded.updated_at`;
    const visitSql = `
      INSERT INTO user_venues
        (username, venue_id, first_visit, first_checkin_id, recent_visit, recent_checkin_id, total_count, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, venue_id) DO UPDATE SET
        first_visit=excluded.first_visit, first_checkin_id=excluded.first_checkin_id,
        recent_visit=excluded.recent_visit, recent_checkin_id=excluded.recent_checkin_id,
        total_count=excluded.total_count, synced_at=excluded.synced_at`;
    let added = 0;
    let updated = 0;
    this.db.transaction(() => {
      const prior = new Map(this.getUserVenueVisits(key, items.map((i) => i.visit.venue_id)).map((r) => [r.venue_id, r]));
      const seen = new Set<number>();
      for (const { venue: v, visit: u } of items) {
        this.db.run(venueSql, [v.venue_id, v.name, v.category, v.address, v.city, v.state, v.country, v.lat, v.lng, v.is_verified, now]);
        this.db.run(visitSql, [key, u.venue_id, u.first_visit, u.first_checkin_id, u.recent_visit, u.recent_checkin_id, u.total_count, now]);
        if (seen.has(u.venue_id)) continue;
        seen.add(u.venue_id);
        const p = prior.get(u.venue_id);
        if (!p) added++;
        else if (p.recent_visit !== u.recent_visit || p.total_count !== u.total_count) updated++;
      }
    });
    return { added, updated };
  }

  getUserVenueVisits(username: string, venueIds: number[]): UserVenueRow[] {
    const out: UserVenueRow[] = [];
    for (const ids of chunks([...new Set(venueIds)])) {
      if (ids.length === 0) continue;
      const rows = this.db.all(
        `SELECT venue_id, first_visit, first_checkin_id, recent_visit, recent_checkin_id, total_count
         FROM user_venues WHERE username = ? AND venue_id IN (${ids.map(() => '?').join(', ')})`,
        [username.toLowerCase(), ...ids],
      );
      for (const r of rows) out.push(visitFrom(r));
    }
    return out;
  }

  userVenuesCount(username: string): number {
    return Number(this.db.get('SELECT COUNT(*) AS n FROM user_venues WHERE username = ?', [username.toLowerCase()])?.n ?? 0);
  }

  getVenues(venueIds: number[]): VenueRow[] {
    const out: VenueRow[] = [];
    for (const c of chunks([...new Set(venueIds)])) {
      if (c.length === 0) continue;
      const rows = this.db.all(`SELECT * FROM venues WHERE venue_id IN (${c.map(() => '?').join(', ')})`, c);
      for (const r of rows) {
        out.push({
          venue_id: Number(r.venue_id),
          name: str(r.name),
          category: str(r.category),
          address: str(r.address),
          city: str(r.city),
          state: str(r.state),
          country: str(r.country),
          lat: num(r.lat),
          lng: num(r.lng),
          is_verified: num(r.is_verified),
        });
      }
    }
    return out;
  }

  getListState(username: string, list: string): ListSyncState | undefined {
    const r = this.db.get('SELECT * FROM list_sync_state WHERE username = ? AND list = ?', [username.toLowerCase(), list]);
    if (!r) return undefined;
    return {
      username: String(r.username),
      list: String(r.list),
      next_offset: num(r.next_offset),
      total_count: num(r.total_count),
      complete: Number(r.complete) === 1,
      last_synced_at: str(r.last_synced_at),
    };
  }

  /** Read-merge-write in one write transaction (see {@link setState}). */
  setListState(username: string, list: string, patch: Partial<Omit<ListSyncState, 'username' | 'list'>>): void {
    const key = username.toLowerCase();
    this.db.transaction(() => {
      const cur = this.getListState(key, list);
      const pick = <K extends keyof typeof patch>(k: K, fallback: ListSyncState[K]): ListSyncState[K] =>
        k in patch ? (patch[k] as ListSyncState[K]) : (cur?.[k] ?? fallback);
      this.db.run(
        `INSERT INTO list_sync_state (username, list, next_offset, total_count, complete, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, list) DO UPDATE SET
           next_offset=excluded.next_offset, total_count=excluded.total_count,
           complete=excluded.complete, last_synced_at=excluded.last_synced_at`,
        [
          key,
          list,
          pick('next_offset', null),
          pick('total_count', null),
          pick('complete', false) ? 1 : 0,
          pick('last_synced_at', null),
        ],
      );
    });
  }

  /**
   * Cached venues the user has visited that match `q` (see {@link VenueQuery}),
   * most-visited first. Name matching is deliberately loose — a brewery's
   * taproom is its own venue (a brewery_id is not a venue_id), and Untappd keeps
   * "… (duplicate of …)" copies — so a venue matches when the name is a literal
   * case-insensitive substring of it, OR when every significant word of the name
   * (ignoring "co", "company", "inc", "llc", "the") is a whole word of it.
   */
  findVisitedVenues(username: string, q: VenueQuery): VisitedVenue[] {
    const key = username.toLowerCase();
    const select = `SELECT v.venue_id AS venue_id, v.name, v.category, v.address, v.city, v.state, v.country,
        v.lat, v.lng, v.is_verified, u.first_visit, u.first_checkin_id, u.recent_visit, u.recent_checkin_id, u.total_count
      FROM user_venues u JOIN venues v ON v.venue_id = u.venue_id WHERE u.username = ?`;
    const found = new Map<number, VisitedVenue>();

    if (q.venue_ids && q.venue_ids.length > 0) {
      for (const ids of chunks([...new Set(q.venue_ids)])) {
        const rows = this.db.all(`${select} AND u.venue_id IN (${ids.map(() => '?').join(', ')})`, [key, ...ids]);
        for (const r of rows) found.set(Number(r.venue_id), visitedFrom(r));
      }
    }

    const hasName = q.name !== undefined && q.name.trim() !== '';
    const hasGeo = q.lat !== undefined && q.lng !== undefined;
    if (hasName || hasGeo) {
      const where: string[] = [];
      const params: SqlParam[] = [key];
      let tokens: string[] = [];
      if (hasName) {
        const name = q.name!.trim();
        tokens = significantTokens(name);
        // Prefilter: the literal substring, or the longest significant word.
        const longest = tokens.slice().sort((a, b) => b.length - a.length)[0];
        if (longest) {
          where.push(`(v.name ${LIKE_MATCH} OR v.name ${LIKE_MATCH})`);
          params.push(`%${escapeLike(name)}%`, `%${escapeLike(longest)}%`);
        } else {
          where.push(`v.name ${LIKE_MATCH}`);
          params.push(`%${escapeLike(name)}%`);
        }
      }
      if (q.city !== undefined && q.city.trim() !== '') {
        where.push(`v.city ${LIKE_MATCH}`);
        params.push(`%${escapeLike(q.city.trim())}%`);
      }
      if (q.state !== undefined && q.state.trim() !== '') {
        where.push(`v.state ${LIKE_MATCH}`);
        params.push(`%${escapeLike(q.state.trim())}%`);
      }
      const radius = q.radius_m ?? DEFAULT_VISIT_RADIUS_M;
      if (hasGeo) {
        // Bounding-box prefilter; the exact great-circle check runs below.
        const dLat = radius / 111_320;
        const dLng = radius / (111_320 * Math.max(0.01, Math.cos((q.lat! * Math.PI) / 180)));
        where.push('v.lat BETWEEN ? AND ? AND v.lng BETWEEN ? AND ?');
        params.push(q.lat! - dLat, q.lat! + dLat, q.lng! - dLng, q.lng! + dLng);
      }
      const rows = this.db.all(`${select}${where.length ? ` AND ${where.join(' AND ')}` : ''}`, params);
      for (const r of rows) {
        const v = visitedFrom(r);
        if (hasName && !nameMatches(q.name!.trim(), tokens, v.name)) continue;
        if (hasGeo) {
          if (v.lat === null || v.lng === null) continue;
          const d = haversineM(q.lat!, q.lng!, v.lat, v.lng);
          if (d > radius) continue;
          v.distance_m = Math.round(d);
        }
        const prior = found.get(v.venue_id);
        found.set(v.venue_id, prior && v.distance_m === undefined ? prior : v);
      }
    }

    return [...found.values()].sort(
      (a, b) => (b.total_count ?? 0) - (a.total_count ?? 0) || (b.recent_visit ?? '').localeCompare(a.recent_visit ?? '') || a.venue_id - b.venue_id,
    );
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
      served_backfill_last: Number(row.served_backfill_last) === 1,
      beers_accepted_gap: num(row.beers_accepted_gap) ?? 0,
      beers_rescan_target: num(row.beers_rescan_target),
    };
  }

  /**
   * Insert-or-merge sync state. Only keys PRESENT in `patch` are written, so an
   * explicit `null` (e.g. clearing a cursor) overrides the stored value — a `??`
   * merge could not do that.
   */
  setState(username: string, patch: Partial<Omit<SyncState, 'username'>>): void {
    // Read-merge-write in one write transaction, so a second process's patch
    // can't land between the read and the write and be silently reverted.
    this.db.transaction(() => this.mergeState(username, patch));
  }

  private mergeState(username: string, patch: Partial<Omit<SyncState, 'username'>>): void {
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
      served_backfill_last: pick('served_backfill_last', false),
      beers_accepted_gap: pick('beers_accepted_gap', 0),
      beers_rescan_target: pick('beers_rescan_target', null),
    };
    this.db.run(
      `INSERT INTO sync_state
         (username, oldest_max_id, newest_checkin_id, catchup_max_id, last_synced_at, backfill_complete, total_checkins, checkins_truncated, beers_offset, beers_total, beers_complete, served_backfill_last, beers_accepted_gap, beers_rescan_target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         oldest_max_id=excluded.oldest_max_id, newest_checkin_id=excluded.newest_checkin_id,
         catchup_max_id=excluded.catchup_max_id, last_synced_at=excluded.last_synced_at,
         backfill_complete=excluded.backfill_complete, total_checkins=excluded.total_checkins,
         checkins_truncated=excluded.checkins_truncated, beers_offset=excluded.beers_offset,
         beers_total=excluded.beers_total, beers_complete=excluded.beers_complete,
         served_backfill_last=excluded.served_backfill_last, beers_accepted_gap=excluded.beers_accepted_gap,
         beers_rescan_target=excluded.beers_rescan_target`,
      [
        key, next.oldest_max_id, next.newest_checkin_id, next.catchup_max_id, next.last_synced_at,
        next.backfill_complete ? 1 : 0, next.total_checkins, next.checkins_truncated ? 1 : 0,
        next.beers_offset, next.beers_total, next.beers_complete ? 1 : 0, next.served_backfill_last ? 1 : 0,
        next.beers_accepted_gap, next.beers_rescan_target,
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
      cClause.push(`beer_name ${LIKE_MATCH}`);
      cParams.push(like);
      bClause.push(`beer_name ${LIKE_MATCH}`);
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

  /**
   * {@link hasHad} for many bids at once, in two grouped queries per chunk
   * instead of ~4 per bid. Same merge rules: a hit in either source counts,
   * `count` prefers user/beers' authoritative had_count, dates and ratings take
   * the max across both. No per-check-in `matches` — callers of the batch form
   * only want the verdict. Every requested bid gets an entry.
   */
  hasHadMany(username: string, bids: number[]): Map<number, HasHadVerdict> {
    const key = username.toLowerCase();
    const out = new Map<number, HasHadVerdict>();
    const unique = [...new Set(bids)];
    for (const bid of unique) out.set(bid, { had: false, count: 0, last_date: null, best_rating: null, sources: [] });
    for (const part of chunks(unique)) {
      const ph = part.map(() => '?').join(', ');
      for (const r of this.db.all(
        `SELECT bid, COUNT(*) AS c, MAX(rating) AS best, MAX(created_at) AS last
         FROM checkins WHERE username = ? AND bid IN (${ph}) GROUP BY bid`,
        [key, ...part],
      )) {
        const v = out.get(Number(r.bid))!;
        v.had = true;
        v.count = Number(r.c);
        v.best_rating = num(r.best);
        v.last_date = str(r.last);
        v.sources.push('checkins');
      }
      for (const r of this.db.all(
        `SELECT bid, had_count, rating, last_had, first_had FROM distinct_beers WHERE username = ? AND bid IN (${ph})`,
        [key, ...part],
      )) {
        const v = out.get(Number(r.bid))!;
        v.had = true;
        // Prefer the user/beers count; else keep the check-in-derived count; else 1.
        v.count = num(r.had_count) ?? (v.count || 1);
        const rating = num(r.rating);
        if (rating !== null && (v.best_rating === null || rating > v.best_rating)) v.best_rating = rating;
        const last = str(r.last_had) ?? str(r.first_had);
        if (last && (v.last_date === null || last > v.last_date)) v.last_date = last;
        v.sources.push('beers');
      }
    }
    return out;
  }

  query(username: string, filters: QueryFilters): CheckinRow[] {
    const where: string[] = ['username = ?'];
    const params: SqlParam[] = [username.toLowerCase()];
    if (filters.brewery_id !== undefined) {
      where.push('brewery_id = ?');
      params.push(filters.brewery_id);
    }
    if (filters.brewery !== undefined) {
      where.push(`brewery_name ${LIKE_MATCH}`);
      params.push(`%${escapeLike(filters.brewery)}%`);
    }
    if (filters.style !== undefined) {
      where.push(`beer_style ${LIKE_MATCH}`);
      params.push(`%${escapeLike(filters.style)}%`);
    }
    if (filters.min_rating !== undefined) {
      where.push('rating >= ?');
      params.push(filters.min_rating);
    }
    if (filters.venue !== undefined) {
      where.push(`venue_name ${LIKE_MATCH}`);
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
          ? 'rating IS NULL, rating DESC, created_at DESC'
          : filters.sort === 'lowest_rated'
            ? 'rating IS NULL, rating ASC, created_at DESC'
            : 'created_at DESC, checkin_id DESC';
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
    return this.db.all(
      `SELECT * FROM checkins WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      [...params, limit],
    ) as unknown as CheckinRow[];
  }

  /**
   * Delete one user's cached rows (case-insensitive) from every per-user table
   * in a single transaction. Shared tables (beer_meta, venues, brewery lists,
   * response cache, the API call log) hold no personal history and are kept.
   */
  forgetUser(username: string): ForgetResult {
    const key = username.toLowerCase();
    const removed = {} as ForgetResult;
    this.db.transaction(() => {
      for (const table of PER_USER_TABLES) {
        removed[table] = Number(this.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE username = ?`, [key])?.n ?? 0);
        this.db.run(`DELETE FROM ${table} WHERE username = ?`, [key]);
      }
    });
    return removed;
  }

  /** Append API call observations to the shared log, pruning entries past retention. */
  recordApiCalls(rows: ApiCallObservation[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(
          'INSERT INTO api_calls (at, status, remaining, limit_hdr, reset_at, retry_after_s) VALUES (?, ?, ?, ?, ?, ?)',
          [r.at, r.status, r.remaining, r.limit, r.reset_at, r.retry_after_s],
        );
      }
      this.db.run('DELETE FROM api_calls WHERE at < ?', [Date.now() - API_CALL_LOG_RETENTION_MS]);
    });
  }

  /** Logged API calls at or after `sinceMs`, oldest first. */
  recentApiCalls(sinceMs: number): ApiCallObservation[] {
    return this.db
      .all('SELECT * FROM api_calls WHERE at >= ? ORDER BY at, rowid', [sinceMs])
      .map((r) => ({
        at: Number(r.at),
        status: Number(r.status),
        remaining: num(r.remaining),
        limit: num(r.limit_hdr),
        reset_at: num(r.reset_at),
        retry_after_s: num(r.retry_after_s),
      }));
  }

  getDistinctBeers(username: string, bids: number[]): DistinctBeerRow[] {
    if (bids.length === 0) return [];
    const placeholders = bids.map(() => '?').join(', ');
    return this.db.all(
      `SELECT * FROM distinct_beers WHERE username = ? AND bid IN (${placeholders})`,
      [username.toLowerCase(), ...bids],
    ) as unknown as DistinctBeerRow[];
  }

  getResolutions(keys: string[]): ItemResolution[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    return this.db.all(
      `SELECT * FROM item_resolutions WHERE key IN (${placeholders})`,
      keys,
    ) as unknown as ItemResolution[];
  }

  upsertResolutions(rows: ItemResolution[]): void {
    if (rows.length === 0) return;
    const sql = `
      INSERT INTO item_resolutions (key, item, status, bid, data, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        item=excluded.item, status=excluded.status, bid=excluded.bid,
        data=excluded.data, resolved_at=excluded.resolved_at`;
    this.db.transaction(() => {
      for (const r of rows) this.db.run(sql, [r.key, r.item, r.status, r.bid, r.data, r.resolved_at]);
    });
  }

  stats(): CacheStats {
    const n = (sql: string) => Number(this.db.get(sql, [])?.n ?? 0);
    const names = this.db
      .all(
        `SELECT username FROM sync_state
         UNION SELECT DISTINCT username FROM distinct_beers
         UNION SELECT DISTINCT username FROM checkins
         UNION SELECT DISTINCT username FROM user_venues
         UNION SELECT username FROM list_sync_state WHERE list IN ('venues', 'wishlist', 'brewery_likes')
         UNION SELECT DISTINCT username FROM wishlist
         UNION SELECT DISTINCT username FROM brewery_likes
         ORDER BY username`,
        [],
      )
      .map((r) => String(r.username));
    const users = names.map((username): CacheUserStats => {
      const st = this.getState(username);
      return {
        username,
        cached_distinct_beers: this.distinctBeersCount(username),
        total_distinct_beers: st?.beers_total ?? null,
        cached_checkins: this.cachedCount(username),
        coverage_complete: (st?.beers_complete ?? false) || (st?.backfill_complete ?? false),
        beers_offset: st?.beers_offset ?? null,
        last_synced_at: st?.last_synced_at ?? null,
        venues: this.venueCoverage(username),
        wishlist: this.wishlistCoverage(username),
        brewery_likes: this.breweryLikesCoverage(username),
      };
    });
    return {
      schema_version: this.version,
      users,
      resolution_cache_entries: n('SELECT COUNT(*) AS n FROM item_resolutions'),
      beer_meta_entries: n('SELECT COUNT(*) AS n FROM beer_meta'),
      venue_entries: n('SELECT COUNT(*) AS n FROM venues'),
      brewery_lists: n('SELECT COUNT(*) AS n FROM brewery_beer_lists'),
      response_cache_entries: n('SELECT COUNT(*) AS n FROM response_cache'),
    };
  }

  /** The user's user/venues coverage, or null if their venue history was never synced. */
  venueCoverage(username: string): VenueCoverage | null {
    // Literal keys: VENUES_LIST / VENUES_REFRESH_LIST in sync-venues.ts.
    const st = this.getListState(username, 'venues');
    const cached = this.userVenuesCount(username);
    if (!st && cached === 0) return null;
    const refresh = this.getListState(username, 'venues_refresh');
    const refreshing = (st?.complete ?? false) && !!refresh && !refresh.complete;
    const total = st?.total_count ?? null;
    const complete = (st?.complete ?? false) && !refreshing;
    return {
      cached_venues: cached,
      total_venues: total,
      complete,
      refresh_in_progress: refreshing,
      percent: total && total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : complete ? 100 : null,
      next_offset: refreshing ? refresh!.next_offset : (st?.next_offset ?? null),
      last_synced_at: st?.last_synced_at ?? null,
    };
  }

  getBreweryBeerList(breweryId: number): BreweryBeerList | undefined {
    const h = this.db.get('SELECT * FROM brewery_beer_lists WHERE brewery_id = ?', [breweryId]);
    if (!h) return undefined;
    const beers = this.db
      .all(
        `SELECT * FROM brewery_beers WHERE brewery_id = ?
         ORDER BY popularity_rank IS NULL, popularity_rank, checkin_count IS NULL, checkin_count DESC, bid`,
        [breweryId],
      )
      .map((r): BreweryBeerRow => ({
        brewery_id: Number(r.brewery_id),
        bid: Number(r.bid),
        beer_name: str(r.beer_name),
        style: str(r.style),
        abv: num(r.abv),
        ibu: num(r.ibu),
        rating_score: num(r.rating_score),
        rating_count: num(r.rating_count),
        checkin_count: num(r.checkin_count),
        in_production: r.in_production === null || r.in_production === undefined ? null : Number(r.in_production) !== 0,
        popularity_rank: num(r.popularity_rank),
        fetched_at: String(r.fetched_at),
      }));
    return {
      brewery_id: breweryId,
      brewery_name: str(h.brewery_name),
      total_count: num(h.total_count),
      ranked_count: Number(h.ranked_count ?? 0),
      fetched_at: String(h.fetched_at),
      beers,
    };
  }

  /**
   * Store one brewery/beer_list page in one transaction. `restart` (a stale or
   * refreshed list) drops the old rows and restarts the TTL clock; otherwise the
   * page is merged into the current snapshot, which keeps its fetched_at. A page
   * fetched in popularity order at an offset inside the ranked prefix extends it.
   */
  saveBreweryBeerPage(page: BreweryBeerPage): void {
    this.db.transaction(() => {
      const cur = this.db.get('SELECT * FROM brewery_beer_lists WHERE brewery_id = ?', [page.brewery_id]);
      const fresh = page.restart || !cur;
      if (page.restart) this.db.run('DELETE FROM brewery_beers WHERE brewery_id = ?', [page.brewery_id]);
      let ranked = fresh ? 0 : Number(cur!.ranked_count ?? 0);
      if (page.ranked_offset !== null && page.ranked_offset <= ranked) {
        ranked = Math.max(ranked, page.ranked_offset + page.item_count);
      }
      this.db.run(
        `INSERT INTO brewery_beer_lists (brewery_id, brewery_name, total_count, ranked_count, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(brewery_id) DO UPDATE SET
           brewery_name = COALESCE(excluded.brewery_name, brewery_beer_lists.brewery_name),
           total_count = COALESCE(excluded.total_count, brewery_beer_lists.total_count),
           ranked_count = excluded.ranked_count,
           fetched_at = excluded.fetched_at`,
        [
          page.brewery_id,
          page.brewery_name,
          page.total_count,
          ranked,
          fresh ? page.fetched_at : String(cur!.fetched_at),
        ],
      );
      for (const r of page.rows) {
        this.db.run(
          `INSERT INTO brewery_beers (brewery_id, bid, beer_name, style, abv, ibu, rating_score, rating_count,
             checkin_count, in_production, popularity_rank, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(brewery_id, bid) DO UPDATE SET
             beer_name = excluded.beer_name, style = excluded.style, abv = excluded.abv, ibu = excluded.ibu,
             rating_score = excluded.rating_score, rating_count = excluded.rating_count,
             checkin_count = excluded.checkin_count, in_production = excluded.in_production,
             popularity_rank = COALESCE(excluded.popularity_rank, brewery_beers.popularity_rank),
             fetched_at = excluded.fetched_at`,
          [
            r.brewery_id,
            r.bid,
            r.beer_name,
            r.style,
            r.abv,
            r.ibu,
            r.rating_score,
            r.rating_count,
            r.checkin_count,
            r.in_production === null ? null : r.in_production ? 1 : 0,
            r.popularity_rank,
            r.fetched_at,
          ],
        );
      }
    });
  }

  getCachedResponse(key: string): CachedResponse | undefined {
    const r = this.db.get('SELECT * FROM response_cache WHERE key = ?', [key]);
    if (!r) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(String(r.data));
    } catch {
      return undefined;
    }
    return { key, kind: String(r.kind), data, fetched_at: String(r.fetched_at) };
  }

  putCachedResponse(key: string, kind: string, data: unknown, fetchedAt: string): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO response_cache (key, kind, data, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, data = excluded.data, fetched_at = excluded.fetched_at`,
        [key, kind, JSON.stringify(data ?? null), fetchedAt],
      );
      // These responses hold other people's recent check-ins; keep them only
      // as long as any TTL could still serve them.
      const cutoff = new Date(Date.parse(fetchedAt) - RESPONSE_CACHE_RETENTION_MS).toISOString();
      this.db.run('DELETE FROM response_cache WHERE fetched_at < ?', [cutoff]);
    });
  }

  upsertWishlist(username: string, rows: WishlistRow[], passStamp: string): number {
    if (rows.length === 0) return 0;
    const key = username.toLowerCase();
    let added = 0;
    this.db.transaction(() => {
      const bids = rows.map((r) => r.bid);
      const known = new Set<number>();
      for (const c of chunks(bids)) {
        for (const r of this.db.all(
          `SELECT bid FROM wishlist WHERE username = ? AND bid IN (${c.map(() => '?').join(', ')})`,
          [key, ...c],
        )) {
          known.add(Number(r.bid));
        }
      }
      for (const r of rows) {
        if (!known.has(r.bid)) {
          added++;
          known.add(r.bid);
        }
        this.db.run(
          `INSERT INTO wishlist (username, bid, beer_name, brewery_id, brewery_name, style, abv, added_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(username, bid) DO UPDATE SET
             beer_name = excluded.beer_name, brewery_id = excluded.brewery_id, brewery_name = excluded.brewery_name,
             style = excluded.style, abv = excluded.abv, added_at = excluded.added_at, synced_at = excluded.synced_at`,
          [key, r.bid, r.beer_name, r.brewery_id, r.brewery_name, r.style, r.abv, r.added_at, passStamp],
        );
      }
    });
    return added;
  }

  pruneWishlist(username: string, passStamp: string): number {
    let removed = 0;
    this.db.transaction(() => {
      const key = username.toLowerCase();
      removed = Number(
        this.db.get('SELECT COUNT(*) AS n FROM wishlist WHERE username = ? AND synced_at <> ?', [key, passStamp])?.n ?? 0,
      );
      this.db.run('DELETE FROM wishlist WHERE username = ? AND synced_at <> ?', [key, passStamp]);
    });
    return removed;
  }

  wishlistCount(username: string): number {
    return Number(this.db.get('SELECT COUNT(*) AS n FROM wishlist WHERE username = ?', [username.toLowerCase()])?.n ?? 0);
  }

  getWishlist(username: string, bids?: number[]): WishlistRow[] {
    const key = username.toLowerCase();
    const map = (r: Row): WishlistRow => ({
      bid: Number(r.bid),
      beer_name: str(r.beer_name),
      brewery_id: num(r.brewery_id),
      brewery_name: str(r.brewery_name),
      style: str(r.style),
      abv: num(r.abv),
      added_at: str(r.added_at),
    });
    if (bids === undefined) {
      return this.db.all('SELECT * FROM wishlist WHERE username = ? ORDER BY added_at DESC, bid', [key]).map(map);
    }
    const out: WishlistRow[] = [];
    for (const c of chunks(bids)) {
      if (c.length === 0) continue;
      out.push(
        ...this.db
          .all(`SELECT * FROM wishlist WHERE username = ? AND bid IN (${c.map(() => '?').join(', ')})`, [key, ...c])
          .map(map),
      );
    }
    return out;
  }

  /** The user's wishlist mirror coverage, or null if it was never synced. */
  wishlistCoverage(username: string): WishlistCoverage | null {
    // Literal key: WISHLIST_LIST in sync-wishlist.ts.
    const st = this.getListState(username, 'wishlist');
    const cached = this.wishlistCount(username);
    if (!st && cached === 0) return null;
    return {
      cached,
      total: st?.total_count ?? null,
      complete: st?.complete ?? false,
      next_offset: st?.next_offset ?? null,
      last_synced_at: st?.last_synced_at ?? null,
    };
  }

  upsertBreweryLikes(username: string, rows: BreweryLikeRow[], passStamp: string): number {
    if (rows.length === 0) return 0;
    const key = username.toLowerCase();
    let added = 0;
    this.db.transaction(() => {
      const known = new Set<number>();
      for (const c of chunks(rows.map((r) => r.brewery_id))) {
        for (const r of this.db.all(
          `SELECT brewery_id FROM brewery_likes WHERE username = ? AND brewery_id IN (${c.map(() => '?').join(', ')})`,
          [key, ...c],
        )) {
          known.add(Number(r.brewery_id));
        }
      }
      for (const r of rows) {
        if (!known.has(r.brewery_id)) {
          added++;
          known.add(r.brewery_id);
        }
        this.db.run(
          `INSERT INTO brewery_likes (username, brewery_id, brewery_name, brewery_type, country, city, state, lat, lng, liked_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(username, brewery_id) DO UPDATE SET
             brewery_name = excluded.brewery_name, brewery_type = excluded.brewery_type, country = excluded.country,
             city = excluded.city, state = excluded.state, lat = excluded.lat, lng = excluded.lng,
             liked_at = excluded.liked_at, synced_at = excluded.synced_at`,
          [key, r.brewery_id, r.brewery_name, r.brewery_type, r.country, r.city, r.state, r.lat, r.lng, r.liked_at, passStamp],
        );
      }
    });
    return added;
  }

  pruneBreweryLikes(username: string, passStamp: string): number {
    let removed = 0;
    this.db.transaction(() => {
      const key = username.toLowerCase();
      removed = Number(
        this.db.get('SELECT COUNT(*) AS n FROM brewery_likes WHERE username = ? AND synced_at <> ?', [key, passStamp])?.n ?? 0,
      );
      this.db.run('DELETE FROM brewery_likes WHERE username = ? AND synced_at <> ?', [key, passStamp]);
    });
    return removed;
  }

  breweryLikesCount(username: string): number {
    return Number(this.db.get('SELECT COUNT(*) AS n FROM brewery_likes WHERE username = ?', [username.toLowerCase()])?.n ?? 0);
  }

  getBreweryLikes(username: string, breweryIds?: number[]): BreweryLikeRow[] {
    const key = username.toLowerCase();
    const map = (r: Row): BreweryLikeRow => ({
      brewery_id: Number(r.brewery_id),
      brewery_name: str(r.brewery_name),
      brewery_type: str(r.brewery_type),
      country: str(r.country),
      city: str(r.city),
      state: str(r.state),
      lat: num(r.lat),
      lng: num(r.lng),
      liked_at: str(r.liked_at),
    });
    const order = 'ORDER BY liked_at IS NULL, liked_at DESC, brewery_id';
    if (breweryIds === undefined) {
      return this.db.all(`SELECT * FROM brewery_likes WHERE username = ? ${order}`, [key]).map(map);
    }
    const out: BreweryLikeRow[] = [];
    for (const c of chunks(breweryIds)) {
      if (c.length === 0) continue;
      out.push(
        ...this.db
          .all(`SELECT * FROM brewery_likes WHERE username = ? AND brewery_id IN (${c.map(() => '?').join(', ')}) ${order}`, [key, ...c])
          .map(map),
      );
    }
    return out;
  }

  /** The user's Untappd brewery-likes coverage, or null if it was never synced. */
  breweryLikesCoverage(username: string): BreweryLikesCoverage | null {
    // Literal key: BREWERY_LIKES_LIST in sync-brewery-likes.ts.
    const st = this.getListState(username, 'brewery_likes');
    const cached = this.breweryLikesCount(username);
    if (!st && cached === 0) return null;
    const total = st?.total_count ?? null;
    const complete = st?.complete ?? false;
    return {
      cached,
      total,
      complete,
      percent: total && total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : complete ? 100 : null,
      next_offset: st?.next_offset ?? null,
      last_synced_at: st?.last_synced_at ?? null,
    };
  }

  venueDrinkCandidates(
    username: string,
    opts: { venueIds?: number[]; which?: 'both' | 'first' | 'recent' } = {},
  ): VenueDrinkCandidate[] {
    const key = username.toLowerCase();
    const which = opts.which ?? 'both';
    const venueFilter = (ids: number[]) => (ids.length ? ` AND u.venue_id IN (${ids.map(() => '?').join(', ')})` : '');
    const parts: Array<{ col: string; kind: 'first' | 'recent' }> = [];
    if (which !== 'recent') parts.push({ col: 'first_checkin_id', kind: 'first' });
    if (which !== 'first') parts.push({ col: 'recent_checkin_id', kind: 'recent' });
    const idSets = opts.venueIds && opts.venueIds.length > 0 ? chunks([...new Set(opts.venueIds)]) : [[]];
    const rows: Row[] = [];
    for (const ids of idSets) {
      for (const { col, kind } of parts) {
        rows.push(
          ...this.db
            .all(
              `SELECT u.venue_id AS venue_id, u.${col} AS checkin_id, u.total_count AS total_count, u.recent_visit AS recent_visit
               FROM user_venues u
               WHERE u.username = ? AND u.${col} IS NOT NULL${venueFilter(ids)}
                 AND NOT EXISTS (SELECT 1 FROM venue_drinks d WHERE d.username = u.username AND d.checkin_id = u.${col})`,
              [key, ...ids],
            )
            .map((r) => ({ ...r, kind })),
        );
      }
    }
    rows.sort(
      (a, b) =>
        Number(b.total_count ?? 0) - Number(a.total_count ?? 0) ||
        String(b.recent_visit ?? '').localeCompare(String(a.recent_visit ?? '')) ||
        Number(a.venue_id) - Number(b.venue_id) ||
        (a.kind === b.kind ? 0 : a.kind === 'first' ? -1 : 1),
    );
    const seen = new Set<number>();
    const out: VenueDrinkCandidate[] = [];
    for (const r of rows) {
      const id = Number(r.checkin_id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ venue_id: Number(r.venue_id), checkin_id: id, kind: r.kind as 'first' | 'recent' });
    }
    return out;
  }

  upsertVenueDrinks(username: string, rows: VenueDrinkRow[], fetchedAt: string): void {
    if (rows.length === 0) return;
    const key = username.toLowerCase();
    const sql = `
      INSERT INTO venue_drinks (username, venue_id, checkin_id, bid, beer_name, brewery_id, brewery_name, created_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, checkin_id) DO UPDATE SET
        venue_id=excluded.venue_id, bid=excluded.bid, beer_name=excluded.beer_name, brewery_id=excluded.brewery_id,
        brewery_name=excluded.brewery_name, created_at=excluded.created_at, fetched_at=excluded.fetched_at`;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(sql, [key, r.venue_id, r.checkin_id, r.bid, r.beer_name, r.brewery_id, r.brewery_name, r.created_at, fetchedAt]);
      }
    });
  }

  getVenueDrinks(username: string, venueIds: number[]): VenueDrinkRow[] {
    const key = username.toLowerCase();
    const out: VenueDrinkRow[] = [];
    for (const ids of chunks([...new Set(venueIds)])) {
      if (ids.length === 0) continue;
      const rows = this.db.all(
        `SELECT venue_id, checkin_id, bid, beer_name, brewery_id, brewery_name, created_at FROM venue_drinks
         WHERE username = ? AND venue_id IN (${ids.map(() => '?').join(', ')})
           AND NOT (bid IS NULL AND beer_name IS NULL)`,
        [key, ...ids],
      );
      for (const r of rows) {
        out.push({
          venue_id: Number(r.venue_id),
          checkin_id: Number(r.checkin_id),
          bid: num(r.bid),
          beer_name: str(r.beer_name),
          brewery_id: num(r.brewery_id),
          brewery_name: str(r.brewery_name),
          created_at: str(r.created_at),
        });
      }
    }
    return out.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || b.checkin_id - a.checkin_id);
  }

  addFavorite(username: string, kind: FavoriteKind, id: number, note: string | null | undefined, createdAt: string): AddFavoriteResult {
    const key = username.toLowerCase();
    let out: AddFavoriteResult = { added: false, note: null, created_at: createdAt };
    this.db.transaction(() => {
      const cur = this.db.get('SELECT note, created_at FROM favorites WHERE username = ? AND kind = ? AND id = ?', [key, kind, id]);
      if (!cur) {
        const n = note ?? null;
        this.db.run('INSERT INTO favorites (username, kind, id, note, created_at) VALUES (?, ?, ?, ?, ?)', [key, kind, id, n, createdAt]);
        out = { added: true, note: n, created_at: createdAt };
        return;
      }
      const n = note === undefined ? str(cur.note) : note;
      this.db.run('UPDATE favorites SET note = ? WHERE username = ? AND kind = ? AND id = ?', [n, key, kind, id]);
      out = { added: false, note: n, created_at: String(cur.created_at) };
    });
    return out;
  }

  removeFavorite(username: string, kind: FavoriteKind, id: number): boolean {
    let removed = false;
    this.db.transaction(() => {
      const key = username.toLowerCase();
      removed = !!this.db.get('SELECT 1 AS x FROM favorites WHERE username = ? AND kind = ? AND id = ?', [key, kind, id]);
      if (removed) this.db.run('DELETE FROM favorites WHERE username = ? AND kind = ? AND id = ?', [key, kind, id]);
    });
    return removed;
  }

  getManualFavorites(username: string, opts: { kind?: FavoriteKind; ids?: number[] } = {}): ManualFavoriteRow[] {
    const key = username.toLowerCase();
    // Best-effort display name from whatever the cache already holds.
    const nameSql = `CASE f.kind
        WHEN 'beer' THEN COALESCE(
          (SELECT beer_name FROM distinct_beers d WHERE d.username = f.username AND d.bid = f.id),
          (SELECT name FROM beer_meta m WHERE m.bid = f.id),
          (SELECT beer_name FROM checkins c WHERE c.username = f.username AND c.bid = f.id LIMIT 1),
          (SELECT beer_name FROM wishlist w WHERE w.username = f.username AND w.bid = f.id))
        WHEN 'brewery' THEN COALESCE(
          (SELECT brewery_name FROM brewery_beer_lists l WHERE l.brewery_id = f.id),
          (SELECT brewery_name FROM distinct_beers d WHERE d.username = f.username AND d.brewery_id = f.id LIMIT 1),
          (SELECT brewery FROM beer_meta m WHERE m.brewery_id = f.id LIMIT 1),
          (SELECT brewery_name FROM checkins c WHERE c.username = f.username AND c.brewery_id = f.id LIMIT 1))
        ELSE (SELECT name FROM venues v WHERE v.venue_id = f.id) END`;
    const where = ['f.username = ?'];
    const params: SqlParam[] = [key];
    if (opts.kind) {
      where.push('f.kind = ?');
      params.push(opts.kind);
    }
    const run = (extra: string, extraParams: SqlParam[]) =>
      this.db
        .all(
          `SELECT f.kind AS kind, f.id AS id, f.note AS note, f.created_at AS created_at, ${nameSql} AS name
           FROM favorites f WHERE ${[...where, ...(extra ? [extra] : [])].join(' AND ')}`,
          [...params, ...extraParams],
        )
        .map((r) => ({
          kind: String(r.kind) as FavoriteKind,
          id: Number(r.id),
          note: str(r.note),
          created_at: String(r.created_at),
          name: str(r.name),
        }));
    let rows: ManualFavoriteRow[];
    if (opts.ids === undefined) rows = run('', []);
    else {
      rows = [];
      for (const c of chunks([...new Set(opts.ids)])) {
        if (c.length) rows.push(...run(`f.id IN (${c.map(() => '?').join(', ')})`, c));
      }
    }
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.kind.localeCompare(b.kind) || a.id - b.id);
  }

  /**
   * One row per distinct beer the user has had, from BOTH sources: user/beers
   * (rating = the user's rating, times = had_count) and check-ins for beers
   * user/beers doesn't hold. `best` is the max rating across both (as
   * hasHadMany), `avg_basis` the rating used for brewery averages.
   */
  private perBeerSql(bidFilter: string): string {
    return `WITH c AS (
        SELECT bid, COUNT(*) AS n, MAX(NULLIF(rating, 0)) AS best, AVG(NULLIF(rating, 0)) AS avg_r,
               MAX(beer_name) AS beer_name, MAX(brewery_id) AS brewery_id, MAX(brewery_name) AS brewery_name
        FROM checkins WHERE username = ? AND bid IS NOT NULL${bidFilter} GROUP BY bid),
      d AS (
        SELECT bid, had_count, NULLIF(rating, 0) AS rating, beer_name, brewery_id, brewery_name
        FROM distinct_beers WHERE username = ?${bidFilter}),
      ids AS (SELECT bid FROM c UNION SELECT bid FROM d)
      SELECT ids.bid AS bid,
             COALESCE(d.beer_name, c.beer_name) AS beer_name,
             COALESCE(d.brewery_id, c.brewery_id) AS brewery_id,
             COALESCE(d.brewery_name, c.brewery_name) AS brewery_name,
             CASE WHEN d.rating IS NULL THEN c.best WHEN c.best IS NULL THEN d.rating
                  WHEN d.rating > c.best THEN d.rating ELSE c.best END AS best,
             COALESCE(d.rating, c.avg_r) AS avg_basis,
             COALESCE(d.had_count, c.n, 1) AS times_had
      FROM ids LEFT JOIN d ON d.bid = ids.bid LEFT JOIN c ON c.bid = ids.bid`;
  }

  breweryHadStats(username: string, breweryIds?: number[]): BreweryHadStats[] {
    const key = username.toLowerCase();
    const sql = (filter: string) =>
      `SELECT brewery_id, MAX(brewery_name) AS brewery_name, COUNT(*) AS beers, COUNT(avg_basis) AS rated,
              AVG(avg_basis) AS avg_rating
       FROM (${this.perBeerSql('')}) WHERE brewery_id IS NOT NULL${filter} GROUP BY brewery_id`;
    const map = (r: Row): BreweryHadStats => ({
      brewery_id: Number(r.brewery_id),
      brewery_name: str(r.brewery_name),
      beers: Number(r.beers),
      rated_beers: Number(r.rated),
      avg_rating: num(r.avg_rating),
    });
    if (breweryIds === undefined) return this.db.all(sql(''), [key, key]).map(map);
    const out: BreweryHadStats[] = [];
    for (const c of chunks([...new Set(breweryIds)])) {
      if (c.length) out.push(...this.db.all(sql(` AND brewery_id IN (${c.map(() => '?').join(', ')})`), [key, key, ...c]).map(map));
    }
    return out;
  }

  beerHadStats(username: string, opts: { bids?: number[]; minRating?: number; minTimesHad?: number }): BeerHadStats[] {
    const key = username.toLowerCase();
    const map = (r: Row): BeerHadStats => ({
      bid: Number(r.bid),
      beer_name: str(r.beer_name),
      brewery_id: num(r.brewery_id),
      brewery_name: str(r.brewery_name),
      rating: num(r.best),
      times_had: Number(r.times_had),
    });
    if (opts.bids !== undefined) {
      const out: BeerHadStats[] = [];
      for (const c of chunks([...new Set(opts.bids)])) {
        if (c.length === 0) continue;
        const f = ` AND bid IN (${c.map(() => '?').join(', ')})`;
        out.push(...this.db.all(this.perBeerSql(f), [key, ...c, key, ...c]).map(map));
      }
      return out;
    }
    return this.db
      .all(`SELECT * FROM (${this.perBeerSql('')}) WHERE best >= ? OR times_had >= ?`, [
        key,
        key,
        opts.minRating ?? Number.MAX_VALUE,
        opts.minTimesHad ?? Number.MAX_SAFE_INTEGER,
      ])
      .map(map);
  }

  venueVisitStats(username: string, opts: { venueIds?: number[]; minCheckins?: number }): VisitedVenue[] {
    const key = username.toLowerCase();
    const base = `SELECT u.*, v.name, v.category, v.address, v.city, v.state, v.country, v.lat, v.lng, v.is_verified
       FROM user_venues u LEFT JOIN venues v ON v.venue_id = u.venue_id
       WHERE u.username = ? AND COALESCE(u.total_count, 0) >= ?`;
    const min = opts.minCheckins ?? 0;
    if (opts.venueIds === undefined) return this.db.all(base, [key, min]).map(visitedFrom);
    const out: VisitedVenue[] = [];
    for (const c of chunks([...new Set(opts.venueIds)])) {
      if (c.length) out.push(...this.db.all(`${base} AND u.venue_id IN (${c.map(() => '?').join(', ')})`, [key, min, ...c]).map(visitedFrom));
    }
    return out;
  }

  getBeerMeta(bids: number[]): BeerMeta[] {
    if (bids.length === 0) return [];
    const placeholders = bids.map(() => '?').join(', ');
    return this.db.all(
      `SELECT * FROM beer_meta WHERE bid IN (${placeholders})`,
      bids,
    ) as unknown as BeerMeta[];
  }

  upsertBeerMeta(rows: BeerMeta[]): void {
    if (rows.length === 0) return;
    const sql = `
      INSERT INTO beer_meta
        (bid, name, brewery, brewery_id, style, parent_style, abv, ibu, weighted_rating_score, rating_score, rating_count, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bid) DO UPDATE SET
        name=excluded.name, brewery=excluded.brewery, brewery_id=excluded.brewery_id,
        style=excluded.style, parent_style=excluded.parent_style, abv=excluded.abv, ibu=excluded.ibu,
        weighted_rating_score=excluded.weighted_rating_score, rating_score=excluded.rating_score,
        rating_count=excluded.rating_count, fetched_at=excluded.fetched_at`;
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run(sql, [
          r.bid, r.name, r.brewery, r.brewery_id, r.style, r.parent_style, r.abv, r.ibu,
          r.weighted_rating_score, r.rating_score, r.rating_count, r.fetched_at,
        ]);
      }
    });
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
  async hasHadMany(username: string, bids: number[]): Promise<Map<number, HasHadVerdict>> {
    return this.core.hasHadMany(username, bids);
  }
  async query(username: string, filters: QueryFilters): Promise<CheckinRow[]> {
    return this.core.query(username, filters);
  }
  async getBeerMeta(bids: number[]): Promise<BeerMeta[]> {
    return this.core.getBeerMeta(bids);
  }
  async upsertBeerMeta(rows: BeerMeta[]): Promise<void> {
    this.core.upsertBeerMeta(rows);
  }
  async forgetUser(username: string): Promise<ForgetResult> {
    return this.core.forgetUser(username);
  }
  async getDistinctBeers(username: string, bids: number[]): Promise<DistinctBeerRow[]> {
    return this.core.getDistinctBeers(username, bids);
  }
  async getResolutions(keys: string[]): Promise<ItemResolution[]> {
    return this.core.getResolutions(keys);
  }
  async upsertResolutions(rows: ItemResolution[]): Promise<void> {
    this.core.upsertResolutions(rows);
  }
  async stats(): Promise<CacheStats> {
    return this.core.stats();
  }
  async upsertUserVenues(username: string, items: UserVenueItem[]): Promise<{ added: number; updated: number }> {
    return this.core.upsertUserVenues(username, items);
  }
  async getUserVenueVisits(username: string, venueIds: number[]): Promise<UserVenueRow[]> {
    return this.core.getUserVenueVisits(username, venueIds);
  }
  async userVenuesCount(username: string): Promise<number> {
    return this.core.userVenuesCount(username);
  }
  async getVenues(venueIds: number[]): Promise<VenueRow[]> {
    return this.core.getVenues(venueIds);
  }
  async getListState(username: string, list: string): Promise<ListSyncState | undefined> {
    return this.core.getListState(username, list);
  }
  async setListState(username: string, list: string, patch: Partial<Omit<ListSyncState, 'username' | 'list'>>): Promise<void> {
    this.core.setListState(username, list, patch);
  }
  async findVisitedVenues(username: string, q: VenueQuery): Promise<VisitedVenue[]> {
    return this.core.findVisitedVenues(username, q);
  }
  async getBreweryBeerList(breweryId: number): Promise<BreweryBeerList | undefined> {
    return this.core.getBreweryBeerList(breweryId);
  }
  async saveBreweryBeerPage(page: BreweryBeerPage): Promise<void> {
    this.core.saveBreweryBeerPage(page);
  }
  async getCachedResponse(key: string): Promise<CachedResponse | undefined> {
    return this.core.getCachedResponse(key);
  }
  async putCachedResponse(key: string, kind: string, data: unknown, fetchedAt: string): Promise<void> {
    this.core.putCachedResponse(key, kind, data, fetchedAt);
  }
  async upsertWishlist(username: string, rows: WishlistRow[], passStamp: string): Promise<number> {
    return this.core.upsertWishlist(username, rows, passStamp);
  }
  async pruneWishlist(username: string, passStamp: string): Promise<number> {
    return this.core.pruneWishlist(username, passStamp);
  }
  async wishlistCount(username: string): Promise<number> {
    return this.core.wishlistCount(username);
  }
  async getWishlist(username: string, bids?: number[]): Promise<WishlistRow[]> {
    return this.core.getWishlist(username, bids);
  }
  async upsertBreweryLikes(username: string, rows: BreweryLikeRow[], passStamp: string): Promise<number> {
    return this.core.upsertBreweryLikes(username, rows, passStamp);
  }
  async pruneBreweryLikes(username: string, passStamp: string): Promise<number> {
    return this.core.pruneBreweryLikes(username, passStamp);
  }
  async breweryLikesCount(username: string): Promise<number> {
    return this.core.breweryLikesCount(username);
  }
  async getBreweryLikes(username: string, breweryIds?: number[]): Promise<BreweryLikeRow[]> {
    return this.core.getBreweryLikes(username, breweryIds);
  }
  async breweryLikesCoverage(username: string): Promise<BreweryLikesCoverage | null> {
    return this.core.breweryLikesCoverage(username);
  }
  async venueDrinkCandidates(
    username: string,
    opts?: { venueIds?: number[]; which?: 'both' | 'first' | 'recent' },
  ): Promise<VenueDrinkCandidate[]> {
    return this.core.venueDrinkCandidates(username, opts);
  }
  async upsertVenueDrinks(username: string, rows: VenueDrinkRow[], fetchedAt: string): Promise<void> {
    this.core.upsertVenueDrinks(username, rows, fetchedAt);
  }
  async getVenueDrinks(username: string, venueIds: number[]): Promise<VenueDrinkRow[]> {
    return this.core.getVenueDrinks(username, venueIds);
  }
  async addFavorite(username: string, kind: FavoriteKind, id: number, note: string | null | undefined, createdAt: string): Promise<AddFavoriteResult> {
    return this.core.addFavorite(username, kind, id, note, createdAt);
  }
  async removeFavorite(username: string, kind: FavoriteKind, id: number): Promise<boolean> {
    return this.core.removeFavorite(username, kind, id);
  }
  async getManualFavorites(username: string, opts?: { kind?: FavoriteKind; ids?: number[] }): Promise<ManualFavoriteRow[]> {
    return this.core.getManualFavorites(username, opts);
  }
  async breweryHadStats(username: string, breweryIds?: number[]): Promise<BreweryHadStats[]> {
    return this.core.breweryHadStats(username, breweryIds);
  }
  async beerHadStats(username: string, opts: { bids?: number[]; minRating?: number; minTimesHad?: number }): Promise<BeerHadStats[]> {
    return this.core.beerHadStats(username, opts);
  }
  async venueVisitStats(username: string, opts: { venueIds?: number[]; minCheckins?: number }): Promise<VisitedVenue[]> {
    return this.core.venueVisitStats(username, opts);
  }
  async recordApiCalls(rows: ApiCallObservation[]): Promise<void> {
    this.core.recordApiCalls(rows);
  }
  async recentApiCalls(sinceMs: number): Promise<ApiCallObservation[]> {
    return this.core.recentApiCalls(sinceMs);
  }
}

// SQLite caps bound parameters per statement (999 on older builds); IN-lists
// are split well under that.
const IN_CHUNK = 500;
function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

// Case-insensitive substring match whose pattern is built by escapeLike(): the
// ESCAPE clause makes a backslash-prefixed %, _ or backslash match itself literally.
const LIKE_MATCH = "LIKE ? COLLATE NOCASE ESCAPE '\\'";

// Escape LIKE wildcards in user input so a literal % or _ in a beer/brewery/venue
// name matches itself instead of acting as a wildcard (pair with LIKE_MATCH).
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function visitFrom(r: Row): UserVenueRow {
  return {
    venue_id: Number(r.venue_id),
    first_visit: str(r.first_visit),
    first_checkin_id: num(r.first_checkin_id),
    recent_visit: str(r.recent_visit),
    recent_checkin_id: num(r.recent_checkin_id),
    total_count: num(r.total_count),
  };
}

function visitedFrom(r: Row): VisitedVenue {
  const name = str(r.name);
  return {
    name,
    category: str(r.category),
    address: str(r.address),
    city: str(r.city),
    state: str(r.state),
    country: str(r.country),
    lat: num(r.lat),
    lng: num(r.lng),
    is_verified: num(r.is_verified),
    ...visitFrom(r),
    is_duplicate: name !== null && /\(duplicate of\b/i.test(name),
  };
}

// Words that don't distinguish one venue name from another ("Green Bench
// Brewing Co." vs "Green Bench Brewing Company").
const NAME_STOP_WORDS = new Set(['co', 'company', 'inc', 'llc', 'ltd', 'the', 'and']);

/** Lowercased alphanumeric words of a name, minus {@link NAME_STOP_WORDS}. */
function significantTokens(name: string): string[] {
  return wordsOf(name).filter((w) => !NAME_STOP_WORDS.has(w));
}
function wordsOf(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** See {@link CheckinStoreCore.findVisitedVenues}: literal substring, or every significant word whole. */
function nameMatches(query: string, tokens: string[], venueName: string | null): boolean {
  if (venueName === null) return false;
  if (venueName.toLowerCase().includes(query.toLowerCase())) return true;
  if (tokens.length === 0) return false;
  const words = new Set(wordsOf(venueName));
  return tokens.every((t) => words.has(t));
}

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
