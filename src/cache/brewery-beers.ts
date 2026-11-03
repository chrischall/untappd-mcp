import type { UntappdClient } from '../client.js';
import { mapBreweryBeerItem, type BreweryBeerList, type BreweryBeerRow, type CacheStore } from './store.js';

/** Default TTL of a cached brewery beer list. */
export const BREWERY_BEERS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Untappd's own default page size for brewery/beer_list. */
export const BREWERY_BEERS_DEFAULT_LIMIT = 25;

export type BrewerySort = 'name' | 'style' | 'abv' | 'rating' | 'count';

export interface BreweryBeersRequest {
  limit?: number;
  offset?: number;
  sort?: BrewerySort;
  /** Bypass a fresh cached list and re-fetch (restarting the snapshot). */
  refresh?: boolean;
  /** Override the TTL (default {@link BREWERY_BEERS_TTL_MS}). */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: Date;
}

export interface BreweryBeersResult {
  brewery_id: number;
  brewery_name: string | null;
  total_count: number | null;
  /** Where these rows came from on this call. */
  source: 'cache' | 'api';
  /** When the cached snapshot was started (null without a cache). */
  fetched_at: string | null;
  expires_at: string | null;
  beers: BreweryBeerRow[];
  /** The raw API response, when this call made one. */
  raw?: unknown;
}

type BeerListResponse = {
  total_count?: number;
  brewery?: { brewery_name?: string };
  beers?: { count?: number; total_count?: number; items?: unknown[] };
};

/** Local sort that approximates Untappd's for each sort key. */
function sortRows(rows: BreweryBeerRow[], sort: BrewerySort): BreweryBeerRow[] {
  const byNum = (f: (r: BreweryBeerRow) => number | null) => (a: BreweryBeerRow, b: BreweryBeerRow) =>
    (f(b) ?? -Infinity) - (f(a) ?? -Infinity) || a.bid - b.bid;
  const byStr = (f: (r: BreweryBeerRow) => string | null) => (a: BreweryBeerRow, b: BreweryBeerRow) =>
    (f(a) ?? '￿').localeCompare(f(b) ?? '￿', 'en', { sensitivity: 'base' }) || a.bid - b.bid;
  const cmp = {
    name: byStr((r) => r.beer_name),
    style: byStr((r) => r.style),
    abv: byNum((r) => r.abv),
    rating: byNum((r) => r.rating_score),
    count: byNum((r) => r.checkin_count),
  }[sort];
  return [...rows].sort(cmp);
}

/**
 * The requested window from a FRESH cached list, or null when the cache can't
 * answer it faithfully: the default (popularity) order is served from the
 * contiguous ranked prefix; any other sort only once the WHOLE list is cached
 * (sorting a top-50 subset by name would silently be a different answer).
 */
export function serveFromList(list: BreweryBeerList, req: BreweryBeersRequest): BreweryBeerRow[] | null {
  const offset = req.offset ?? 0;
  const limit = req.limit ?? BREWERY_BEERS_DEFAULT_LIMIT;
  const total = list.total_count;
  const complete = total !== null && list.beers.length >= total;
  if (req.sort === undefined) {
    const end = total !== null ? Math.min(offset + limit, total) : offset + limit;
    if (list.ranked_count >= end || complete) return list.beers.slice(offset, offset + limit);
    return null;
  }
  if (!complete) return null;
  return sortRows(list.beers, req.sort).slice(offset, offset + limit);
}

/**
 * A brewery's beers, from the cache when its list is fresh (TTL default 7 days)
 * and covers the window, else from brewery/beer_list (one call) — which is then
 * stored. A stale list, or `refresh: true`, restarts the snapshot so beers that
 * left the list don't linger. Rows carry only global facts: beer_list's
 * `has_had` is the AUTHENTICATED account's and is never kept or returned.
 */
export async function getBreweryBeers(
  client: UntappdClient,
  cache: CacheStore | undefined,
  breweryId: number,
  req: BreweryBeersRequest = {},
): Promise<BreweryBeersResult> {
  const now = req.now ?? new Date();
  const ttl = req.ttlMs ?? BREWERY_BEERS_TTL_MS;
  const expiry = (fetchedAt: string) => new Date(Date.parse(fetchedAt) + ttl).toISOString();
  const cached = cache ? await cache.getBreweryBeerList(breweryId) : undefined;
  const fresh = cached !== undefined && now.getTime() - Date.parse(cached.fetched_at) < ttl;

  if (cached && fresh && !req.refresh) {
    const rows = serveFromList(cached, req);
    if (rows) {
      return {
        brewery_id: breweryId,
        brewery_name: cached.brewery_name,
        total_count: cached.total_count,
        source: 'cache',
        fetched_at: cached.fetched_at,
        expires_at: expiry(cached.fetched_at),
        beers: rows,
      };
    }
  }

  const offset = req.offset ?? 0;
  const raw = await client.get<BeerListResponse>(`/brewery/beer_list/${breweryId}`, {
    limit: req.limit,
    offset: req.offset,
    sort: req.sort,
  });
  const items = Array.isArray(raw?.beers?.items) ? raw.beers!.items : [];
  const total =
    typeof raw?.total_count === 'number'
      ? raw.total_count
      : typeof raw?.beers?.total_count === 'number'
        ? raw.beers.total_count
        : null;
  const stamp = now.toISOString();
  const ranked = req.sort === undefined;
  const rows: BreweryBeerRow[] = [];
  let breweryName: string | null = typeof raw?.brewery?.brewery_name === 'string' ? raw.brewery.brewery_name : null;
  items.forEach((it, i) => {
    const r = mapBreweryBeerItem(breweryId, it, stamp, ranked ? offset + i : null);
    if (r) rows.push(r);
    const n = (it as { brewery?: { brewery_name?: unknown } })?.brewery?.brewery_name;
    if (breweryName === null && typeof n === 'string') breweryName = n;
  });

  let fetchedAt: string | null = null;
  if (cache) {
    const restart = !cached || !fresh || req.refresh === true;
    await cache.saveBreweryBeerPage({
      brewery_id: breweryId,
      brewery_name: breweryName,
      total_count: total,
      rows,
      ranked_offset: ranked ? offset : null,
      item_count: items.length,
      restart,
      fetched_at: stamp,
    });
    fetchedAt = restart ? stamp : cached!.fetched_at;
  }
  return {
    brewery_id: breweryId,
    brewery_name: breweryName,
    total_count: total,
    source: 'api',
    fetched_at: fetchedAt,
    expires_at: fetchedAt ? expiry(fetchedAt) : null,
    beers: rows,
    raw,
  };
}
