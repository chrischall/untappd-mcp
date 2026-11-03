import { createHelpfulError, RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { mapUserVenueItem, type CacheStore, type UserVenueItem } from './store.js';
import { checkRateBudget, resumeAdvice, stopFrom429, stopFromVerdict, type RateStop } from '../ratelimit.js';

/** The `list_sync_state` key for a user's venue history. */
export const VENUES_LIST = 'venues';
/**
 * What we ASK for per page. Untappd returns at most 25 venues whatever the
 * limit (live, 2026-11), so the cursor advances by the returned
 * `pagination.offset` — never by this number.
 */
export const VENUES_PAGE_REQUEST = 50;
/** The most venues a page has been seen to hold; a shorter page is the last one. */
const VENUES_SERVER_PAGE_MAX = 25;
/**
 * A resumed backfill re-reads this many already-fetched venues: if the list
 * shifted up between runs (a venue dropped out), the ones that crossed the
 * stored offset would otherwise be skipped. Upserts are idempotent.
 */
export const VENUES_RESUME_OVERLAP = 5;
/** Hard cap on pages per call, whatever the caller asks. */
export const VENUES_MAX_PAGES_CAP = 50;

export interface SyncVenuesSummary {
  username: string;
  /** Venues new to the cache this run. */
  venues_added: number;
  /** Cached venues whose recent_visit or total_count changed this run. */
  venues_updated: number;
  pages_fetched: number;
  cached_venues: number;
  total_venues: number | null;
  backfill_percent: number | null;
  venues_complete: boolean;
  /** True when this run was a top-of-list refresh of an already-complete history. */
  incremental: boolean;
  another_run_needed: boolean;
  next_offset: number | null;
  stopped_for_rate_limit: boolean;
  rate_limit?: RateStop;
  last_synced_at: string;
  note: string;
}

interface VenuesPage {
  items: unknown[];
  total: number | null;
  /** pagination.offset — the offset of the NEXT page — when Untappd sent one. */
  nextOffset: number | null;
}

async function fetchVenuesPage(client: UntappdClient, encodedUser: string, offset: number): Promise<VenuesPage> {
  const data = await client.get<{
    total_count?: number;
    venues?: { count?: number; total_count?: number; items?: unknown[] };
    items?: unknown[];
    pagination?: { offset?: unknown };
  }>(`/user/venues/${encodedUser}`, { limit: VENUES_PAGE_REQUEST, offset, sort: 'date' });
  const items = Array.isArray(data?.venues?.items)
    ? (data.venues!.items as unknown[])
    : Array.isArray(data?.items)
      ? (data.items as unknown[])
      : [];
  const total =
    typeof data?.total_count === 'number'
      ? data.total_count
      : typeof data?.venues?.total_count === 'number'
        ? data.venues.total_count
        : null;
  const po = data?.pagination?.offset;
  const nextOffset = typeof po === 'number' ? po : typeof po === 'string' && /^\d+$/.test(po) ? Number(po) : null;
  return { items, total, nextOffset };
}

/**
 * Sync a user's complete venue history (user/venues) into `venues` +
 * `user_venues`. Unlike user/checkins, user/venues pages a NON-self account's
 * whole history, so this is how "has this person been here?" gets answered.
 *
 * Resumable backfill: offset-paged (sort=date), the cursor and total persisted
 * after EVERY page, at most `maxPages` (capped at 50) per call, stopping before
 * the hourly rate limit. Once the whole list is cached, a re-run is an
 * incremental refresh: page from offset 0 and stop at the first page on which
 * every venue's recent_visit (and visit count) is unchanged.
 */
export async function syncUserVenues(
  client: UntappdClient,
  cache: CacheStore,
  rawUsername: string,
  maxPages = 10,
): Promise<SyncVenuesSummary> {
  const pagesBudget = Math.max(1, Math.min(VENUES_MAX_PAGES_CAP, Math.floor(maxPages)));
  const encodedUser = encodeURIComponent(rawUsername);
  const now = () => new Date().toISOString();
  const prior = await cache.getListState(rawUsername, VENUES_LIST);

  const incremental = (prior?.complete ?? false) && !!prior?.last_synced_at;
  let offset = incremental ? 0 : Math.max(0, (prior?.next_offset ?? 0) - (prior?.next_offset ? VENUES_RESUME_OVERLAP : 0));
  let total = prior?.total_count ?? null;
  let complete = incremental; // a refresh keeps the history complete whether or not it reaches a stop page
  let done = false;
  let pages = 0;
  let added = 0;
  let updated = 0;
  let rateStop: RateStop | undefined;

  while (pages < pagesBudget && !done) {
    const verdict = await checkRateBudget(client, cache);
    if (!verdict.ok) {
      rateStop = stopFromVerdict(verdict);
      break;
    }
    let page: VenuesPage;
    try {
      page = await fetchVenuesPage(client, encodedUser, offset);
    } catch (e) {
      if (e instanceof RateLimitError) {
        rateStop = stopFrom429(e);
        break;
      }
      if (pages > 0) throw e;
      throw createHelpfulError(`Could not fetch the venue history for "${rawUsername}": ${messageOf(e)}`, {
        hint: "Untappd only returns another user's venues if their account is public or they're your friend. If the account is private, add them as a friend (untappd_add_friend) first.",
      });
    }
    pages++;
    if (page.total !== null) total = page.total;

    const mapped: UserVenueItem[] = [];
    for (const it of page.items) {
      const m = mapUserVenueItem(rawUsername, it);
      if (m) mapped.push(m);
    }

    // Incremental: a page on which every venue is already cached with the same
    // recent_visit and count is where this refresh meets the last one — the
    // list is newest-visit first, so nothing below it has changed.
    let unchangedPage = false;
    if (incremental && mapped.length > 0) {
      const known = new Map(
        (await cache.getUserVenueVisits(rawUsername, mapped.map((m) => m.visit.venue_id))).map((r) => [r.venue_id, r]),
      );
      unchangedPage = mapped.every((m) => {
        const k = known.get(m.visit.venue_id);
        return k !== undefined && k.recent_visit === m.visit.recent_visit && k.total_count === m.visit.total_count;
      });
    }
    if (!unchangedPage && mapped.length > 0) {
      const r = await cache.upsertUserVenues(rawUsername, mapped);
      added += r.added;
      updated += r.updated;
    }

    // Advance by what Untappd says the next offset is (it serves 25 per page
    // even when asked for 50); fall back to counting the items it sent.
    const advanced = page.nextOffset !== null && page.nextOffset > offset ? page.nextOffset : offset + page.items.length;
    const atEnd =
      page.items.length === 0 ||
      (total !== null ? advanced >= total : page.items.length < VENUES_SERVER_PAGE_MAX);
    offset = advanced;

    if (unchangedPage || atEnd) {
      done = true;
      complete = true;
    }
    await cache.setListState(rawUsername, VENUES_LIST, {
      // A refresh leaves the cursor at the end of the list, not mid-refresh.
      next_offset: complete ? (total ?? offset) : offset,
      total_count: total,
      complete,
      last_synced_at: now(),
    });
  }

  const cached = await cache.userVenuesCount(rawUsername);
  const percent = total && total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : complete ? 100 : null;
  const anotherRunNeeded = !complete;
  const progress = `${cached}${total !== null ? `/${total}` : ''}`;
  const note = complete
    ? incremental
      ? `Venue history refreshed (${progress} cached). Re-run occasionally to pick up new visits.`
      : `Full venue history is cached (${progress}) — untappd_cache_has_visited answers are complete for this user.`
    : rateStop
      ? `Venue history sync paused (${progress}). ${resumeAdvice(rateStop, 'untappd_sync_user_venues')}`
      : `Venue history sync in progress (${progress}). Run untappd_sync_user_venues again to fetch the next ${pagesBudget} pages.`;

  const state = await cache.getListState(rawUsername, VENUES_LIST);
  return {
    username: rawUsername,
    venues_added: added,
    venues_updated: updated,
    pages_fetched: pages,
    cached_venues: cached,
    total_venues: total,
    backfill_percent: percent,
    venues_complete: complete,
    incremental,
    another_run_needed: anotherRunNeeded,
    next_offset: state?.next_offset ?? null,
    stopped_for_rate_limit: rateStop !== undefined,
    ...(rateStop ? { rate_limit: rateStop } : {}),
    last_synced_at: now(),
    note,
  };
}
