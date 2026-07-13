import { createHelpfulError, RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { mapCheckinRow, type CacheStore, type CheckinRow } from './store.js';

const PAGE_LIMIT = 50; // Untappd's max page size for /user/checkins.
// Backfill counts as complete only when the cache holds ~this fraction of the
// API's reported total_checkins — allowing drift for deleted check-ins. Below
// this after reaching the end means the endpoint refused to page (truncated).
const COVERAGE_THRESHOLD = 0.98;
// Absolute coverage drift allowed on top of the ratio, so a few new/deleted
// check-ins on a SMALL fully-backfilled history aren't mistaken for an
// incomplete backfill. Deliberately its own constant, not PAGE_LIMIT: it's a
// tolerance for count drift, unrelated to how many rows a page returns.
const COVERAGE_DRIFT_FLOOR = 50;

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
  /** True when user/checkins refused to page the full history (non-self accounts). */
  history_truncated: boolean;
  /** True when this run reset the sync state (force_backfill or self-heal). */
  forced: boolean;
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

/** Best-effort stats.total_checkins; null if it can't be read. */
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
 * Whether `cached` check-ins covers ~all of `total` (null total = can't verify →
 * assume yes). Uses BOTH an absolute drift floor and a relative threshold, so a
 * handful of new check-ins on a small, fully-backfilled history (e.g. 200 of 205)
 * is not mistaken for an incomplete backfill and needlessly re-paged.
 */
function reachedFullCoverage(cached: number, total: number | null): boolean {
  if (total === null || total <= 0) return true;
  return cached >= total - COVERAGE_DRIFT_FLOOR || cached >= Math.floor(total * COVERAGE_THRESHOLD);
}

export interface SyncCheckinsOptions {
  /**
   * TOTAL page budget for THIS run (the documented per-call rate-limit
   * contract). The catch-up and backfill phases SHARE it — the budget is split
   * across them so neither is starved — and the combined pages fetched in one
   * call never exceed `maxPages`.
   */
  maxPages?: number;
  /**
   * Reset the sync state (clear backfill_complete + cursors) while KEEPING cached
   * rows, then page the whole history backward from newest. Recovers a cache
   * wrongly marked complete. Resumable across runs like a normal backfill.
   */
  force?: boolean;
}

/**
 * Sync a user's Untappd check-ins into the cache from user/checkins.
 *
 * Incremental catch-up of new check-ins, then a resumable backward backfill.
 * `backfill_complete` is set ONLY when the cache holds ~all of the API's reported
 * total_checkins — so a sync that stops early (the endpoint returns just the ~50
 * most recent for non-self accounts and won't page) reports `history_truncated`
 * instead of falsely claiming completion. Such a cache is healed automatically on
 * the next run, or explicitly via `force`.
 */
export async function syncCheckins(
  client: UntappdClient,
  cache: CacheStore,
  rawUsername: string,
  options: SyncCheckinsOptions | number = {},
): Promise<SyncSummary> {
  // Back-compat: a bare number is the maxPages positional argument.
  const opts: SyncCheckinsOptions = typeof options === 'number' ? { maxPages: options } : options;
  const maxPages = opts.maxPages ?? 10;
  const force = opts.force ?? false;

  const encodedUser = encodeURIComponent(rawUsername);
  const now = () => new Date().toISOString();

  const priorState = await cache.getState(rawUsername);
  const total = await fetchTotalCheckins(client, encodedUser);
  const cachedAtStart = await cache.cachedCount(rawUsername);

  // Self-heal a cache wrongly flagged complete (the historical bug): if state
  // claims done but coverage is well short of total, treat it like a forced reset.
  const selfHeal = !force && !!priorState?.backfill_complete && !reachedFullCoverage(cachedAtStart, total);
  const doReset = force || selfHeal;
  if (doReset) {
    await cache.setState(rawUsername, {
      newest_checkin_id: null,
      oldest_max_id: null,
      catchup_max_id: null,
      backfill_complete: false,
      checkins_truncated: false,
      last_synced_at: now(),
    });
  }

  const priorNewest = doReset ? null : (priorState?.newest_checkin_id ?? null);
  let pages = 0;
  let added = 0;
  let newest = priorNewest;
  let backfillComplete = doReset ? false : (priorState?.backfill_complete ?? false);
  let oldestMaxId = doReset ? null : (priorState?.oldest_max_id ?? null);
  let catchupMaxId = doReset ? null : (priorState?.catchup_max_id ?? null);
  let catchupInProgress = catchupMaxId !== null;
  // Restore from prior so a known-truncated account skips Phase 2 (the
  // `!checkinsTruncated` guard) instead of re-probing the stall every sync.
  // A force/self-heal reset clears it above, so a changed situation still recovers.
  let checkinsTruncated = doReset ? false : (priorState?.checkins_truncated ?? false);

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
  // Only the very first network call of the whole run gets the friendlier
  // wrapped error; every call after that uses the plain fetch.
  let usedFirstFetch = false;
  const nextFetch = async (maxId: number | undefined): Promise<Page> => {
    if (!usedFirstFetch) {
      usedFirstFetch = true;
      return firstFetch(maxId);
    }
    return fetchPage(client, encodedUser, maxId);
  };

  // ── Split the shared per-call page budget across the two phases ──
  // `maxPages` is the TOTAL page budget for this call (the documented
  // rate-limit contract), NOT a per-phase budget. Phase 1 (catch-up) and
  // Phase 2 (backfill) share it. The bug being fixed: a single shared page
  // counter always ran Phase 1 first, and Phase 1 spends at least one page just
  // to reconfirm "nothing new above the cached top" — so a large catch-up burst
  // (or a small maxPages) could leave Phase 2 with ZERO pages every run,
  // forever. The gap below oldest_max_id was then never re-fetched,
  // backfill_complete never became true, and has_had silently false-negatived
  // every bid in that unhealed gap. Fix: give each phase a slice of the shared
  // budget (ceil to catch-up, the remainder to backfill) so both make progress,
  // while the TOTAL fetched stays ≤ maxPages.
  const catchupPending = catchupMaxId !== null; // an interrupted catch-up must finish first
  const wantPhase1 = priorNewest !== null;
  const wantPhase2 = !backfillComplete && !checkinsTruncated && !catchupPending;
  let phase1Budget: number;
  let phase2Budget: number;
  // Preserved unless a max_pages=1 tie below flips it.
  let servedBackfillThisRun = priorState?.served_backfill_last ?? false;
  if (wantPhase1 && wantPhase2) {
    phase1Budget = Math.ceil(maxPages / 2);
    phase2Budget = maxPages - phase1Budget;
    if (phase2Budget === 0) {
      // maxPages === 1: the split zeroes one phase. Alternate which phase gets
      // the single page each run (persisted turn flag) so BOTH converge over
      // repeated runs and neither is permanently starved.
      if (priorState?.served_backfill_last) {
        phase1Budget = 1;
        phase2Budget = 0;
        servedBackfillThisRun = false; // catch-up's turn this run
      } else {
        phase1Budget = 0;
        phase2Budget = 1;
        servedBackfillThisRun = true; // backfill's turn this run
      }
    }
  } else if (wantPhase1) {
    phase1Budget = maxPages;
    phase2Budget = 0;
  } else {
    phase1Budget = 0;
    phase2Budget = maxPages;
  }

  // ── Phase 1: incremental catch-up of the new-top region (resumable) ──
  if (priorNewest !== null && phase1Budget > 0) {
    let maxId: number | undefined = catchupMaxId ?? undefined;
    let caughtUp = false;
    let phase1Pages = 0;
    for (; phase1Pages < phase1Budget; ) {
      const page: Page = await nextFetch(maxId);
      pages++;
      phase1Pages++;
      if (page.items.length === 0) {
        caughtUp = true;
        break;
      }
      const rows = rowsOf(rawUsername, page.items);
      added += await cache.upsertCheckins(rawUsername, rows);
      const oldestOnPage = rows[rows.length - 1].checkin_id;
      if (oldestOnPage <= priorNewest) {
        caughtUp = true; // reconnected to the cached block
        break;
      }
      if (page.nextMaxId === null) {
        caughtUp = true;
        backfillComplete = reachedFullCoverage(await cache.cachedCount(rawUsername), total);
        checkinsTruncated = !backfillComplete;
        oldestMaxId = null;
        break;
      }
      // Stall: the endpoint ignored max_id (truncated account). The new check-ins
      // on this page already landed; stop catching up and advance the boundary to
      // the true top so we don't loop against the rate limit every sync.
      if (maxId !== undefined && page.nextMaxId >= maxId) {
        caughtUp = true;
        checkinsTruncated = true;
        break;
      }
      catchupMaxId = page.nextMaxId;
      await cache.setState(rawUsername, { catchup_max_id: catchupMaxId, last_synced_at: now() });
      maxId = page.nextMaxId;
    }
    if (caughtUp) {
      newest = await cache.newestCachedId(rawUsername);
      catchupMaxId = null;
      catchupInProgress = false;
      await cache.setState(rawUsername, {
        newest_checkin_id: newest,
        catchup_max_id: null,
        backfill_complete: backfillComplete,
        checkins_truncated: checkinsTruncated,
        oldest_max_id: oldestMaxId,
        last_synced_at: now(),
      });
    } else {
      catchupInProgress = true; // budget spent mid-catch-up; next run resumes
    }
  }

  // ── Phase 2: backfill older history (resumable), its slice of the budget ──
  if (!backfillComplete && !catchupInProgress && !checkinsTruncated && phase2Budget > 0) {
    let maxId: number | undefined = oldestMaxId ?? undefined;
    let phase2Pages = 0;
    for (; phase2Pages < phase2Budget; ) {
      const page: Page = await nextFetch(maxId);
      pages++;
      phase2Pages++;
      if (page.items.length === 0) {
        // Reached the end — but only "complete" if coverage is ~full.
        backfillComplete = reachedFullCoverage(await cache.cachedCount(rawUsername), total);
        checkinsTruncated = !backfillComplete;
        break;
      }
      // Stall detection: a correct backward page advances the cursor to an OLDER
      // id. If the endpoint ignores max_id (non-self accounts) the cursor stops
      // moving — treat that as truncation, not progress.
      if (maxId !== undefined && page.nextMaxId !== null && page.nextMaxId >= maxId) {
        checkinsTruncated = true;
        break;
      }
      const rows = rowsOf(rawUsername, page.items);
      added += await cache.upsertCheckins(rawUsername, rows);
      if (newest === null) newest = rows[0].checkin_id;
      oldestMaxId = page.nextMaxId;
      if (page.nextMaxId === null) {
        backfillComplete = reachedFullCoverage(await cache.cachedCount(rawUsername), total);
        checkinsTruncated = !backfillComplete;
      }
      await cache.setState(rawUsername, {
        newest_checkin_id: newest,
        oldest_max_id: oldestMaxId,
        backfill_complete: backfillComplete,
        checkins_truncated: checkinsTruncated,
        last_synced_at: now(),
      });
      if (backfillComplete || checkinsTruncated) break;
      maxId = page.nextMaxId ?? undefined;
    }
  }

  const cached = await cache.cachedCount(rawUsername);
  await cache.setState(rawUsername, {
    newest_checkin_id: newest,
    oldest_max_id: oldestMaxId,
    catchup_max_id: catchupMaxId,
    backfill_complete: backfillComplete,
    checkins_truncated: checkinsTruncated,
    total_checkins: total,
    served_backfill_last: servedBackfillThisRun,
    last_synced_at: now(),
  });

  const backfillPercent =
    total && total > 0
      ? Math.min(100, Math.round((cached / total) * 100))
      : backfillComplete && !catchupInProgress
        ? 100
        : null;
  // Re-running user/checkins only helps while there is more of the OWN history to
  // page. A truncated (non-self) history can't advance that way — the caller
  // should switch to untappd_sync_user_beers for has-had coverage.
  const anotherRunNeeded = catchupInProgress || (!backfillComplete && !checkinsTruncated);

  const note = checkinsTruncated
    ? 'Untappd only returns the most recent check-ins for this account (history_truncated), so the full check-in history cannot be paged. Use untappd_sync_user_beers to cache the complete distinct-beers list for has-had coverage.'
    : catchupInProgress
      ? 'More new check-ins remain than fit in this run — run untappd_sync_checkins again to finish catching up.'
      : backfillComplete
        ? 'Full check-in history is cached. Re-run occasionally to pick up new check-ins.'
        : `Backfill incomplete — run untappd_sync_checkins again to fetch the next ${maxPages} pages of older check-ins.`;

  return {
    username: rawUsername,
    rows_added: added,
    pages_fetched: pages,
    cached_checkins: cached,
    distinct_beers: await cache.checkinsBeerCount(rawUsername),
    total_checkins: total,
    backfill_percent: backfillPercent,
    backfill_complete: backfillComplete,
    catchup_in_progress: catchupInProgress,
    history_truncated: checkinsTruncated,
    forced: doReset,
    another_run_needed: anotherRunNeeded,
    last_synced_at: now(),
    note,
  };
}
