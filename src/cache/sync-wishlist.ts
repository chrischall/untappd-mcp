import { createHelpfulError, RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { mapWishlistItem, type CacheStore, type WishlistRow } from './store.js';
import { checkRateBudget, resumeAdvice, stopFrom429, stopFromVerdict, type RateStop } from '../ratelimit.js';

/** The `list_sync_state` key for a user's wishlist cursor (literal also in store.ts wishlistCoverage). */
export const WISHLIST_LIST = 'wishlist';
/**
 * The `list_sync_state` key whose `last_synced_at` holds the CURRENT pass's
 * stamp. Every row a pass sees is stamped with it, so when the pass reaches the
 * end, rows carrying any other stamp were removed from the wishlist upstream.
 */
export const WISHLIST_PASS_LIST = 'wishlist_pass';
/** What we ask for per page; Untappd may serve fewer, so advance by what it returns. */
export const WISHLIST_PAGE_REQUEST = 50;
const WISHLIST_SERVER_PAGE_MAX = 25;
/** A resumed pass re-reads this many items (the list may have shifted up between runs). */
export const WISHLIST_RESUME_OVERLAP = 5;
export const WISHLIST_MAX_PAGES_CAP = 50;

export interface SyncWishlistSummary {
  username: string;
  /** Beers new to the cached wishlist this run. */
  wishlist_added: number;
  /** Beers dropped because a finished pass no longer saw them upstream. */
  wishlist_removed: number;
  pages_fetched: number;
  cached: number;
  total: number | null;
  /** A full pass has finished: the cache mirrors the wishlist as of last_synced_at. */
  complete: boolean;
  another_run_needed: boolean;
  next_offset: number | null;
  stopped_for_rate_limit: boolean;
  rate_limit?: RateStop;
  last_synced_at: string;
  note: string;
}

/**
 * Mirror a user's wishlist (user/wishlist) into the `wishlist` table so pick
 * tools can boost wishlisted beers without an API call. Wishlists change in
 * both directions, so each sync is a full pass from the top (they are small:
 * ~25 beers per call), resumable across runs with the cursor persisted every
 * page and the stop-before-429 guard before every call. Removals are applied
 * only when a pass reaches the end — a partial pass never deletes.
 */
export async function syncWishlist(
  client: UntappdClient,
  cache: CacheStore,
  rawUsername: string,
  maxPages = 10,
): Promise<SyncWishlistSummary> {
  const pagesBudget = Math.max(1, Math.min(WISHLIST_MAX_PAGES_CAP, Math.floor(maxPages)));
  const encodedUser = encodeURIComponent(rawUsername);
  const now = () => new Date().toISOString();
  const prior = await cache.getListState(rawUsername, WISHLIST_LIST);
  const passRow = await cache.getListState(rawUsername, WISHLIST_PASS_LIST);

  // Resume an unfinished pass; otherwise start a new one from the top, with a
  // stamp strictly later than the previous pass's so old rows never share it.
  const resuming = !!prior && !prior.complete && prior.next_offset !== null && !!passRow?.last_synced_at;
  let passStamp: string;
  let offset: number;
  if (resuming) {
    passStamp = passRow!.last_synced_at!;
    offset = Math.max(0, prior!.next_offset! - WISHLIST_RESUME_OVERLAP);
  } else {
    const prev = passRow?.last_synced_at ? Date.parse(passRow.last_synced_at) : 0;
    passStamp = new Date(Math.max(Date.now(), prev + 1)).toISOString();
    offset = 0;
    await cache.setListState(rawUsername, WISHLIST_PASS_LIST, { last_synced_at: passStamp, complete: false, next_offset: null });
  }

  let total = prior?.total_count ?? null;
  let pages = 0;
  let added = 0;
  let removed = 0;
  let complete = false;
  let rateStop: RateStop | undefined;

  while (pages < pagesBudget && !complete) {
    const verdict = await checkRateBudget(client, cache);
    if (!verdict.ok) {
      rateStop = stopFromVerdict(verdict);
      break;
    }
    let data: {
      total_count?: number;
      beers?: { total_count?: number; items?: unknown[] };
      pagination?: { offset?: unknown };
    };
    try {
      data = await client.get(`/user/wishlist/${encodedUser}`, { limit: WISHLIST_PAGE_REQUEST, offset, sort: 'date' });
    } catch (e) {
      if (e instanceof RateLimitError) {
        rateStop = stopFrom429(e);
        break;
      }
      if (pages > 0) throw e;
      throw createHelpfulError(`Could not fetch the wishlist for "${rawUsername}": ${messageOf(e)}`, {
        hint: "Untappd only returns another user's wishlist if their account is public or they're your friend.",
      });
    }
    pages++;
    const items = Array.isArray(data?.beers?.items) ? data.beers!.items! : [];
    if (typeof data?.total_count === 'number') total = data.total_count;
    else if (typeof data?.beers?.total_count === 'number') total = data.beers.total_count;

    const rows: WishlistRow[] = [];
    for (const it of items) {
      const r = mapWishlistItem(it);
      if (r) rows.push(r);
    }
    added += await cache.upsertWishlist(rawUsername, rows, passStamp);

    const po = data?.pagination?.offset;
    const next = typeof po === 'number' ? po : typeof po === 'string' && /^\d+$/.test(po) ? Number(po) : null;
    const advanced = next !== null && next > offset ? next : offset + items.length;
    complete =
      items.length === 0 || (total !== null ? advanced >= total : items.length < WISHLIST_SERVER_PAGE_MAX);
    offset = advanced;

    if (complete) removed = await cache.pruneWishlist(rawUsername, passStamp);
    await cache.setListState(rawUsername, WISHLIST_LIST, {
      next_offset: complete ? null : offset,
      total_count: total,
      complete,
      last_synced_at: now(),
    });
    if (complete) await cache.setListState(rawUsername, WISHLIST_PASS_LIST, { complete: true });
  }

  const cached = await cache.wishlistCount(rawUsername);
  const progress = `${cached}${total !== null ? `/${total}` : ''}`;
  const note = complete
    ? `Wishlist mirrored (${progress} beers). Re-run to pick up changes — each sync is a fresh pass from the top.`
    : rateStop
      ? `Wishlist sync paused (pass at offset ${offset}). ${resumeAdvice(rateStop, 'untappd_sync_wishlist')}`
      : `Wishlist sync in progress (pass at offset ${offset}). Run untappd_sync_wishlist again to continue; removals apply when the pass finishes.`;
  return {
    username: rawUsername,
    wishlist_added: added,
    wishlist_removed: removed,
    pages_fetched: pages,
    cached,
    total,
    complete,
    another_run_needed: !complete,
    next_offset: complete ? null : offset,
    stopped_for_rate_limit: rateStop !== undefined,
    ...(rateStop ? { rate_limit: rateStop } : {}),
    last_synced_at: now(),
    note,
  };
}
