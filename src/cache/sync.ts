import { createHelpfulError, RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { CheckinCache, mapCheckinRow, type CheckinRow } from './db.js';

const PAGE_LIMIT = 50; // Untappd's max page size for /user/checkins.

export interface SyncSummary {
  username: string;
  rows_added: number;
  pages_fetched: number;
  cached_checkins: number;
  distinct_beers: number;
  total_checkins: number | null;
  backfill_percent: number | null;
  backfill_complete: boolean;
  /** True when a burst of new check-ins exceeded this run's page budget. */
  catchup_in_progress: boolean;
  another_run_needed: boolean;
  last_synced_at: string;
  note: string;
}

interface Page {
  items: unknown[];
  /** pagination.max_id for the NEXT (older) page, or null when exhausted. */
  nextMaxId: number | null;
}

/** One `/user/checkins` page fetch, tolerant of the fat/undocumented shape. */
async function fetchPage(client: UntappdClient, encodedUser: string, maxId: number | undefined): Promise<Page> {
  const data = await client.get<{ checkins?: { items?: unknown[]; pagination?: { max_id?: number | null } } }>(
    `/user/checkins/${encodedUser}`,
    { limit: PAGE_LIMIT, max_id: maxId },
  );
  const box = data?.checkins ?? {};
  const items = Array.isArray(box.items) ? box.items : [];
  const raw = box.pagination?.max_id;
  const nextMaxId = typeof raw === 'number' && raw > 0 ? raw : null;
  return { items, nextMaxId };
}

function rowsOf(username: string, items: unknown[]): CheckinRow[] {
  const rows: CheckinRow[] = [];
  for (const it of items) {
    const r = mapCheckinRow(username, it);
    if (r) rows.push(r);
  }
  return rows;
}

/** Best-effort stats.total_checkins for the % estimate; null if it can't be read. */
async function fetchTotalCheckins(client: UntappdClient, encodedUser: string): Promise<number | null> {
  try {
    const info = await client.get<{ user?: { stats?: { total_checkins?: number } } }>(`/user/info/${encodedUser}`);
    const t = info?.user?.stats?.total_checkins;
    return typeof t === 'number' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Sync a user's Untappd check-ins into the local cache.
 *
 * - **Incremental**: on a repeat sync, page from the top and stop as soon as a
 *   check-in at or below the stored `newest_checkin_id` appears (already cached).
 * - **Backfill**: while `backfill_complete` is false, resume paging backwards
 *   from the stored `oldest_max_id`, up to `maxPages` pages per invocation so a
 *   single run stays well under the rate limit. State is persisted after EVERY
 *   page, so an interrupted run (rate limit, crash) resumes exactly where it
 *   stopped and never loses fetched data.
 *
 * `maxPages` is the TOTAL page budget for the invocation (incremental +
 * backfill), so the call can never fetch more than `maxPages` pages.
 */
export async function syncCheckins(
  client: UntappdClient,
  cache: CheckinCache,
  rawUsername: string,
  maxPages = 10,
): Promise<SyncSummary> {
  const encodedUser = encodeURIComponent(rawUsername);
  const prior = cache.getState(rawUsername);
  const priorNewest = prior?.newest_checkin_id ?? null;

  let pages = 0;
  let added = 0;
  let newest = priorNewest;
  let backfillComplete = prior?.backfill_complete ?? false;
  let oldestMaxId = prior?.oldest_max_id ?? null;
  // Resume cursor for an unfinished top catch-up. Non-null → a prior run advanced
  // partway through a burst of new check-ins but ran out of page budget before
  // reconnecting to the cached block; this run resumes from here.
  let catchupMaxId = prior?.catchup_max_id ?? null;
  let catchupInProgress = catchupMaxId !== null;
  const now = () => new Date().toISOString();

  // Wrap the very first fetch so a private/non-friend account produces a clear,
  // actionable error instead of a raw upstream failure. Rate limits are
  // preserved as-is (they're meaningful and any prior progress is saved).
  const firstFetch = async (maxId: number | undefined): Promise<Page> => {
    try {
      return await fetchPage(client, encodedUser, maxId);
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      throw createHelpfulError(`Could not fetch check-ins for "${rawUsername}": ${messageOf(e)}`, {
        hint: "Untappd only returns another user's check-ins if their account is public or they're your friend. If the account is private, add them as a friend (untappd_add_friend) first, or sync only your own account.",
      });
    }
  };

  // ── Phase 1: incremental catch-up of the new-top region (resumable) ──
  // Only meaningful once we have a cached block (priorNewest set). Pages from the
  // top (or a resumed cursor) DOWN until it reconnects to the cached block —
  // i.e. a page whose oldest id <= priorNewest. Crucially, `newest_checkin_id`
  // is NOT advanced until that reconnection happens: if the run exhausts its page
  // budget first, the boundary stays put and a resume cursor is saved, so a burst
  // of more than maxPages*50 new check-ins can never strand a permanent gap.
  if (priorNewest !== null) {
    let maxId: number | undefined = catchupMaxId ?? undefined;
    let caughtUp = false;
    for (; pages < maxPages; ) {
      const page: Page = pages === 0 ? await firstFetch(maxId) : await fetchPage(client, encodedUser, maxId);
      pages++;
      if (page.items.length === 0) {
        caughtUp = true;
        break;
      }
      const rows = rowsOf(rawUsername, page.items);
      added += cache.upsertCheckins(rawUsername, rows);
      const oldestOnPage = rows[rows.length - 1].checkin_id;
      if (oldestOnPage <= priorNewest) {
        caughtUp = true; // reconnected to the cached block
        break;
      }
      if (page.nextMaxId === null) {
        // Paged all the way to the true bottom via the top — the whole history
        // is now contiguous, so the backfill is complete too.
        caughtUp = true;
        backfillComplete = true;
        oldestMaxId = null;
        break;
      }
      catchupMaxId = page.nextMaxId;
      // Persist the resume cursor after EVERY page; the boundary stays put.
      cache.setState(rawUsername, { catchup_max_id: catchupMaxId, last_synced_at: now() });
      maxId = page.nextMaxId;
    }
    if (caughtUp) {
      // Contiguous from the true newest down to the old block: advance the
      // boundary and clear the catch-up cursor.
      newest = cache.newestCachedId(rawUsername);
      catchupMaxId = null;
      catchupInProgress = false;
      cache.setState(rawUsername, {
        newest_checkin_id: newest,
        catchup_max_id: null,
        backfill_complete: backfillComplete,
        oldest_max_id: oldestMaxId,
        last_synced_at: now(),
      });
    } else {
      catchupInProgress = true; // budget spent mid-catch-up; next run resumes
    }
  }

  // ── Phase 2: backfill older history (resumable) ──
  // Skipped while a catch-up is still in progress (that already spent the budget).
  if (!backfillComplete && !catchupInProgress) {
    // First-ever sync starts from the top (undefined); a resumed backfill picks
    // up from the stored cursor.
    let maxId: number | undefined = oldestMaxId ?? undefined;
    for (; pages < maxPages; ) {
      const first = pages === 0; // true only on a first-ever sync (phase 1 was skipped)
      const page: Page = first ? await firstFetch(maxId) : await fetchPage(client, encodedUser, maxId);
      pages++;
      if (page.items.length === 0) {
        backfillComplete = true;
        break;
      }
      const rows = rowsOf(rawUsername, page.items);
      added += cache.upsertCheckins(rawUsername, rows);
      if (newest === null) newest = rows[0].checkin_id; // first-ever sync sets the boundary
      oldestMaxId = page.nextMaxId;
      if (page.nextMaxId === null) backfillComplete = true;
      // Persist progress after EVERY page so an interruption never loses work.
      cache.setState(rawUsername, {
        newest_checkin_id: newest,
        oldest_max_id: oldestMaxId,
        backfill_complete: backfillComplete,
        last_synced_at: now(),
      });
      if (backfillComplete) break;
      maxId = page.nextMaxId ?? undefined;
    }
  }

  const total = await fetchTotalCheckins(client, encodedUser);
  const cached = cache.cachedCount(rawUsername);
  cache.setState(rawUsername, {
    newest_checkin_id: newest,
    oldest_max_id: oldestMaxId,
    catchup_max_id: catchupMaxId,
    backfill_complete: backfillComplete,
    total_checkins: total,
    last_synced_at: now(),
  });

  const backfillPercent =
    total && total > 0
      ? Math.min(100, Math.round((cached / total) * 100))
      : backfillComplete && !catchupInProgress
        ? 100
        : null;
  // Another run is needed while EITHER frontier is unfinished: the bottom
  // backfill, or an in-progress top catch-up of a large burst of new check-ins.
  const anotherRunNeeded = !backfillComplete || catchupInProgress;

  const note = catchupInProgress
    ? 'More new check-ins remain than fit in this run — run untappd_sync_checkins again to finish catching up the newest check-ins.'
    : backfillComplete
      ? 'Full history is cached. Re-run occasionally to pick up new check-ins.'
      : `Backfill incomplete — run untappd_sync_checkins again to fetch the next ${maxPages} pages of older check-ins.`;

  return {
    username: rawUsername,
    rows_added: added,
    pages_fetched: pages,
    cached_checkins: cached,
    distinct_beers: cache.distinctBeerCount(rawUsername),
    total_checkins: total,
    backfill_percent: backfillPercent,
    backfill_complete: backfillComplete,
    catchup_in_progress: catchupInProgress,
    another_run_needed: anotherRunNeeded,
    last_synced_at: now(),
    note,
  };
}
