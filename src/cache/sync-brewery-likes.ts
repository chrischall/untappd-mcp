import { createHelpfulError, RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { mapBreweryLikeItem, type BreweryLikeRow, type CacheStore } from './store.js';
import { checkRateBudget, resumeAdvice, stopFrom429, stopFromVerdict, type RateStop } from '../ratelimit.js';

/** The `list_sync_state` key for a user's brewery-likes cursor (literal also in store.ts breweryLikesCoverage). */
export const BREWERY_LIKES_LIST = 'brewery_likes';
/**
 * The `list_sync_state` key whose `last_synced_at` holds the CURRENT pass's
 * stamp (same scheme as the wishlist mirror): rows a finished pass did not
 * stamp were unliked upstream.
 */
export const BREWERY_LIKES_PASS_LIST = 'brewery_likes_pass';
/** user/brewerylikes honours limit=50 (live, 6a); still advance by what it returns. */
export const BREWERY_LIKES_PAGE_REQUEST = 50;
/** A resumed pass re-reads this many items (the list may have shifted up between runs). */
export const BREWERY_LIKES_RESUME_OVERLAP = 5;
export const BREWERY_LIKES_MAX_PAGES_CAP = 50;

export interface SyncBreweryLikesSummary {
  username: string;
  /** Breweries new to the cached likes this run. */
  likes_added: number;
  /** Breweries dropped because a finished pass no longer saw them upstream. */
  likes_removed: number;
  pages_fetched: number;
  cached: number;
  total: number | null;
  percent: number | null;
  /** A full pass has finished: the cache mirrors the likes as of last_synced_at. */
  complete: boolean;
  another_run_needed: boolean;
  next_offset: number | null;
  stopped_for_rate_limit: boolean;
  rate_limit?: RateStop;
  last_synced_at: string;
  note: string;
}

const offsetOf = (po: unknown): number | null =>
  typeof po === 'number' ? po : typeof po === 'string' && /^\d+$/.test(po) ? Number(po) : null;

/**
 * Mirror the breweries a user "likes" on Untappd (user/brewerylikes — the
 * app's "following"; works for non-self users) into `brewery_likes`, where they
 * become the "untappd" favorite source. Same shape as the wishlist mirror: each
 * sync is a full pass from the top, resumable across runs with the cursor
 * persisted every page and the stop-before-429 guard before every call; rows
 * are stamped with the pass and only a FINISHED pass removes unliked breweries.
 */
export async function syncBreweryLikes(
  client: UntappdClient,
  cache: CacheStore,
  rawUsername: string,
  maxPages = 10,
): Promise<SyncBreweryLikesSummary> {
  const pagesBudget = Math.max(1, Math.min(BREWERY_LIKES_MAX_PAGES_CAP, Math.floor(maxPages)));
  const encodedUser = encodeURIComponent(rawUsername);
  const now = () => new Date().toISOString();
  const prior = await cache.getListState(rawUsername, BREWERY_LIKES_LIST);
  const passRow = await cache.getListState(rawUsername, BREWERY_LIKES_PASS_LIST);

  const resuming = !!prior && !prior.complete && prior.next_offset !== null && !!passRow?.last_synced_at;
  let passStamp: string;
  let offset: number;
  if (resuming) {
    passStamp = passRow!.last_synced_at!;
    offset = Math.max(0, prior!.next_offset! - BREWERY_LIKES_RESUME_OVERLAP);
  } else {
    const prev = passRow?.last_synced_at ? Date.parse(passRow.last_synced_at) : 0;
    passStamp = new Date(Math.max(Date.now(), prev + 1)).toISOString();
    offset = 0;
    await cache.setListState(rawUsername, BREWERY_LIKES_PASS_LIST, { last_synced_at: passStamp, complete: false, next_offset: null });
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
    let data: { total_count?: unknown; items?: unknown; pagination?: { offset?: unknown } };
    try {
      data = await client.get(`/user/brewerylikes/${encodedUser}`, { limit: BREWERY_LIKES_PAGE_REQUEST, offset });
    } catch (e) {
      if (e instanceof RateLimitError) {
        rateStop = stopFrom429(e);
        break;
      }
      if (pages > 0) throw e;
      throw createHelpfulError(`Could not fetch the liked breweries for "${rawUsername}": ${messageOf(e)}`, {
        hint: "Untappd only returns another user's lists if their account is public or they're your friend.",
      });
    }
    pages++;
    const items = Array.isArray(data?.items) ? (data.items as unknown[]) : [];
    if (typeof data?.total_count === 'number') total = data.total_count;

    const rows: BreweryLikeRow[] = [];
    for (const it of items) {
      const r = mapBreweryLikeItem(it);
      if (r) rows.push(r);
    }
    added += await cache.upsertBreweryLikes(rawUsername, rows, passStamp);

    // pagination.offset is ABSENT on an empty list (live, 6a) — fall back to offset + items.
    const next = offsetOf(data?.pagination?.offset);
    const advanced = next !== null && next > offset ? next : offset + items.length;
    // Without a total, a short page is not proof of the end (a route may serve fewer
    // than it was asked for), so only an empty page ends the pass.
    complete = items.length === 0 || (total !== null && advanced >= total);
    offset = advanced;

    if (complete) removed = await cache.pruneBreweryLikes(rawUsername, passStamp);
    await cache.setListState(rawUsername, BREWERY_LIKES_LIST, {
      next_offset: complete ? null : offset,
      total_count: total,
      complete,
      last_synced_at: now(),
    });
    if (complete) await cache.setListState(rawUsername, BREWERY_LIKES_PASS_LIST, { complete: true });
  }

  const cached = await cache.breweryLikesCount(rawUsername);
  const percent = total !== null && total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : complete ? 100 : null;
  const progress = `${cached}${total !== null ? `/${total}` : ''}`;
  const note = complete
    ? `Liked breweries mirrored (${progress}). They now count as favorites with source "untappd". Re-run to pick up changes — each sync is a fresh pass from the top.`
    : rateStop
      ? `Brewery-likes sync paused (pass at offset ${offset}). ${resumeAdvice(rateStop, 'untappd_sync_brewery_likes')}`
      : `Brewery-likes sync in progress (pass at offset ${offset}). Run untappd_sync_brewery_likes again to continue; unlikes apply when the pass finishes.`;
  return {
    username: rawUsername,
    likes_added: added,
    likes_removed: removed,
    pages_fetched: pages,
    cached,
    total,
    percent,
    complete,
    another_run_needed: !complete,
    next_offset: complete ? null : offset,
    stopped_for_rate_limit: rateStop !== undefined,
    ...(rateStop ? { rate_limit: rateStop } : {}),
    last_synced_at: now(),
    note,
  };
}
