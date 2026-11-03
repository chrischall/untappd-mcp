import type { CacheStore } from './store.js';

/** Default TTL for cached venue menus and venue activity. */
export const VENUE_RESPONSE_TTL_MS = 6 * 60 * 60 * 1000;

export interface CachedResponseOptions {
  /** Override the TTL (default {@link VENUE_RESPONSE_TTL_MS}). */
  ttlMs?: number;
  /** Bypass a fresh entry and re-fetch. */
  refresh?: boolean;
  /** Clock override for tests. */
  now?: Date;
}

export interface CachedResponseResult<T> {
  data: T;
  /** True when served from the cache (no API call). */
  hit: boolean;
  fetched_at: string;
  /** Null without a cache. */
  expires_at: string | null;
}

/**
 * Serve `key` from the short-TTL `response_cache` when fresh, else call
 * `fetch` and store what it returns. A thrown fetch (429, budget, network) is
 * never cached. With no cache it just fetches.
 */
export async function cachedResponse<T>(
  cache: CacheStore | undefined,
  key: string,
  kind: string,
  fetch: () => Promise<T>,
  opts: CachedResponseOptions = {},
): Promise<CachedResponseResult<T>> {
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMs ?? VENUE_RESPONSE_TTL_MS;
  const expiry = (at: string) => new Date(Date.parse(at) + ttl).toISOString();
  if (cache && !opts.refresh) {
    const hit = await cache.getCachedResponse(key);
    if (hit && now.getTime() - Date.parse(hit.fetched_at) < ttl) {
      return { data: hit.data as T, hit: true, fetched_at: hit.fetched_at, expires_at: expiry(hit.fetched_at) };
    }
  }
  const data = await fetch();
  const stamp = now.toISOString();
  if (cache) await cache.putCachedResponse(key, kind, data, stamp);
  return { data, hit: false, fetched_at: stamp, expires_at: cache ? expiry(stamp) : null };
}
