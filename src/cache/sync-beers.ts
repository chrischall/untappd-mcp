import { createHelpfulError, RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { mapBeerRow, type CacheStore, type DistinctBeerRow } from './store.js';

const PAGE_LIMIT = 50; // Untappd's max page size for /user/beers.

export interface SyncBeersSummary {
  username: string;
  beers_added: number;
  pages_fetched: number;
  cached_distinct_beers: number;
  total_distinct_beers: number | null;
  backfill_percent: number | null;
  beers_complete: boolean;
  /** True when this run was a top-of-list refresh of an already-complete cache. */
  incremental: boolean;
  another_run_needed: boolean;
  last_synced_at: string;
  note: string;
}

interface BeersPage {
  items: unknown[];
  total: number | null;
}

/** One `/user/beers` page fetch (offset-paged), tolerant of the fat shape. */
async function fetchBeersPage(client: UntappdClient, encodedUser: string, offset: number): Promise<BeersPage> {
  const data = await client.get<{ total_count?: number; beers?: { count?: number; items?: unknown[] } }>(
    `/user/beers/${encodedUser}`,
    { limit: PAGE_LIMIT, offset, sort: 'date' },
  );
  const items = Array.isArray(data?.beers?.items) ? (data.beers!.items as unknown[]) : [];
  const total = typeof data?.total_count === 'number' ? data.total_count : null;
  return { items, total };
}

function rowsOf(username: string, items: unknown[]): DistinctBeerRow[] {
  const rows: DistinctBeerRow[] = [];
  for (const it of items) {
    const r = mapBeerRow(username, it);
    if (r) rows.push(r);
  }
  return rows;
}

/**
 * Sync a user's complete DISTINCT-beers list into the cache from user/beers —
 * far cheaper than backfilling every check-in when we only need has-had answers,
 * and (unlike user/checkins) fully pageable for any public/friend account.
 *
 * Offset-paged and resumable: the offset is persisted after every page and the
 * run respects `maxPages`, so a large list is filled across several runs
 * (`another_run_needed: true` until `offset >= total_count`). Re-running an
 * already-complete cache does a cheap top-of-list refresh, stopping as soon as a
 * page brings nothing new.
 */
export async function syncUserBeers(
  client: UntappdClient,
  cache: CacheStore,
  rawUsername: string,
  maxPages = 10,
): Promise<SyncBeersSummary> {
  const encodedUser = encodeURIComponent(rawUsername);
  const now = () => new Date().toISOString();
  const prior = await cache.getState(rawUsername);

  // An already-complete cache re-scans from the top to pick up newly-had beers,
  // stopping on the first page with nothing new. Otherwise resume the backfill.
  const incremental = (prior?.beers_complete ?? false) && !!prior?.last_synced_at;
  let offset = incremental ? 0 : (prior?.beers_offset ?? 0);
  let total = prior?.beers_total ?? null;
  let complete = false;
  let pages = 0;
  let added = 0;

  const firstFetch = async (o: number): Promise<BeersPage> => {
    try {
      return await fetchBeersPage(client, encodedUser, o);
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      throw createHelpfulError(`Could not fetch the distinct beers for "${rawUsername}": ${messageOf(e)}`, {
        hint: "Untappd only returns another user's beers if their account is public or they're your friend. If the account is private, add them as a friend (untappd_add_friend) first, or sync only your own account.",
      });
    }
  };

  for (; pages < maxPages && !complete; ) {
    const page = pages === 0 ? await firstFetch(offset) : await fetchBeersPage(client, encodedUser, offset);
    pages++;
    if (page.total !== null) total = page.total;
    if (page.items.length === 0) {
      // An empty (e.g. first) page still means the list is fully paged — persist
      // completion so a subsequent call doesn't re-run the same empty fetch.
      complete = true;
      await cache.setState(rawUsername, {
        beers_offset: incremental ? (total ?? offset) : offset,
        beers_total: total,
        beers_complete: true,
        last_synced_at: now(),
      });
      break;
    }
    const rows = rowsOf(rawUsername, page.items);
    const netNew = await cache.upsertDistinctBeers(rawUsername, rows);
    added += netNew;
    offset += page.items.length;
    // End conditions: caught the whole list, a short (final) page, or — during an
    // incremental top refresh — a page that added nothing new.
    if (total !== null && offset >= total) complete = true;
    else if (page.items.length < PAGE_LIMIT) complete = true;
    else if (incremental && netNew === 0) complete = true;
    // Persist progress after EVERY page. During an incremental refresh the stored
    // offset stays at the completed total so the next run refreshes from the top
    // again rather than resuming a stale cursor.
    await cache.setState(rawUsername, {
      beers_offset: incremental ? (total ?? offset) : offset,
      beers_total: total,
      beers_complete: complete,
      last_synced_at: now(),
    });
  }

  const cachedBeers = await cache.distinctBeersCount(rawUsername);
  const percent =
    total && total > 0 ? Math.min(100, Math.round((cachedBeers / total) * 100)) : complete ? 100 : null;
  const anotherRunNeeded = !complete;

  const note = complete
    ? 'Full distinct-beers list is cached — has-had coverage is complete for this user. Re-run occasionally to pick up newly-had beers.'
    : `Distinct-beers sync in progress (${cachedBeers}${total !== null ? `/${total}` : ''}). Run untappd_sync_user_beers again to fetch the next ${maxPages} pages.`;

  return {
    username: rawUsername,
    beers_added: added,
    pages_fetched: pages,
    cached_distinct_beers: cachedBeers,
    total_distinct_beers: total,
    backfill_percent: percent,
    beers_complete: complete,
    incremental,
    another_run_needed: anotherRunNeeded,
    last_synced_at: now(),
    note,
  };
}
