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

  // ── Phase 1: incremental catch-up (only meaningful once we have a boundary) ──
  if (priorNewest !== null) {
    let maxId: number | undefined = undefined;
    for (; pages < maxPages; ) {
      const page: Page = pages === 0 ? await firstFetch(maxId) : await fetchPage(client, encodedUser, maxId);
      pages++;
      if (page.items.length === 0) break;
      const rows = rowsOf(rawUsername, page.items);
      added += cache.upsertCheckins(rawUsername, rows);
      // The top of page 1 is the newest check-in overall.
      if (newest === null || rows[0].checkin_id > newest) newest = rows[0].checkin_id;
      cache.setState(rawUsername, { newest_checkin_id: newest, last_synced_at: now() });
      // Caught up once this page reaches into already-cached territory.
      const oldestOnPage = rows[rows.length - 1].checkin_id;
      if (oldestOnPage <= priorNewest) break;
      if (page.nextMaxId === null) break;
      maxId = page.nextMaxId;
    }
  }

  // ── Phase 2: backfill older history (resumable) ──
  let backfillComplete = prior?.backfill_complete ?? false;
  let oldestMaxId = prior?.oldest_max_id ?? null;
  if (!backfillComplete) {
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
    backfill_complete: backfillComplete,
    total_checkins: total,
    last_synced_at: now(),
  });

  const backfillPercent =
    total && total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : backfillComplete ? 100 : null;
  const anotherRunNeeded = !backfillComplete;

  return {
    username: rawUsername,
    rows_added: added,
    pages_fetched: pages,
    cached_checkins: cached,
    distinct_beers: cache.distinctBeerCount(rawUsername),
    total_checkins: total,
    backfill_percent: backfillPercent,
    backfill_complete: backfillComplete,
    another_run_needed: anotherRunNeeded,
    last_synced_at: now(),
    note: backfillComplete
      ? 'Full history is cached. Re-run occasionally to pick up new check-ins.'
      : `Backfill incomplete — run untappd_sync_checkins again to fetch the next ${maxPages} pages of older check-ins.`,
  };
}
