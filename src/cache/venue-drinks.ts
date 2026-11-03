import { RateLimitError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { mapCheckinRow, type CacheStore, type VenueDrinkRow } from './store.js';
import { checkRateBudget, resumeAdvice, stopFrom429, stopFromVerdict, type RateStop } from '../ratelimit.js';

export const VENUE_DRINKS_DEFAULT_CALLS = 10;
export const VENUE_DRINKS_MAX_CALLS_CAP = 50;
const TOOL = 'untappd_sync_venue_drinks';

export interface SyncVenueDrinksOptions {
  /** checkin/view calls this run (1–50). */
  maxCalls: number;
  /** Only these venues (default: every cached user_venues row). */
  venueIds?: number[];
  /** Which of each venue's check-ins to fetch (default both). */
  which?: 'both' | 'first' | 'recent';
}

export interface SyncVenueDrinksSummary {
  username: string;
  api_calls: number;
  /** Drinks stored this run. */
  stored: number;
  /** Check-ins Untappd says are gone or private (404) — remembered, never asked again. */
  unavailable: number;
  /** Other failures — left pending, retried next run. */
  errors: number;
  /** Check-ins still to fetch after this run. */
  pending: number;
  another_run_needed: boolean;
  stopped_for_rate_limit: boolean;
  rate_limit?: RateStop;
  first_error?: string;
  note: string;
}

/** A check-in that no longer exists or isn't visible answers 404 (not a transient failure). */
function isGone(e: unknown): boolean {
  return /\b404\b|not found|does not exist/i.test(messageOf(e));
}

/**
 * Opt-in "what did they drink there": for the user's cached user_venues rows,
 * fetch the first and most-recent visit check-ins via checkin/view (works for
 * any public check-in) and store the beer + date in `venue_drinks`. A PARTIAL
 * picture by design — two check-ins per venue at most. Budgeted by `maxCalls`,
 * with the stop-before-429 guard before every call; progress is stored per
 * call, so a re-run continues with what is still pending.
 */
export async function syncVenueDrinks(
  client: UntappdClient,
  cache: CacheStore,
  username: string,
  opts: SyncVenueDrinksOptions,
): Promise<SyncVenueDrinksSummary> {
  const budget = Math.max(1, Math.min(VENUE_DRINKS_MAX_CALLS_CAP, Math.floor(opts.maxCalls)));
  const filter = { venueIds: opts.venueIds, which: opts.which ?? 'both' };
  const candidates = await cache.venueDrinkCandidates(username, filter);

  let calls = 0;
  let stored = 0;
  let unavailable = 0;
  let errors = 0;
  let firstError: string | undefined;
  let rateStop: RateStop | undefined;

  for (const c of candidates) {
    if (calls >= budget) break;
    const verdict = await checkRateBudget(client, cache);
    if (!verdict.ok) {
      rateStop = stopFromVerdict(verdict);
      break;
    }
    calls++;
    let data: { checkin?: unknown };
    try {
      data = await client.get<{ checkin?: unknown }>(`/checkin/view/${c.checkin_id}`);
    } catch (e) {
      if (e instanceof RateLimitError) {
        rateStop = stopFrom429(e);
        break;
      }
      if (isGone(e)) {
        unavailable++;
        await cache.upsertVenueDrinks(
          username,
          [{ venue_id: c.venue_id, checkin_id: c.checkin_id, bid: null, beer_name: null, brewery_id: null, brewery_name: null, created_at: null }],
          new Date().toISOString(),
        );
      } else {
        errors++;
        firstError ??= messageOf(e);
      }
      continue;
    }
    // Only the beer, brewery and date are kept — never the comment (other people's free text).
    const r = mapCheckinRow(username, data?.checkin);
    const row: VenueDrinkRow = {
      venue_id: c.venue_id,
      checkin_id: c.checkin_id,
      bid: r?.bid ?? null,
      beer_name: r?.beer_name ?? null,
      brewery_id: r?.brewery_id ?? null,
      brewery_name: r?.brewery_name ?? null,
      created_at: r?.created_at ?? null,
    };
    if (row.bid === null && row.beer_name === null) {
      // An unexpected shape — don't store a tombstone for it; count and retry later.
      errors++;
      firstError ??= `checkin/view ${c.checkin_id} had no beer`;
      continue;
    }
    await cache.upsertVenueDrinks(username, [row], new Date().toISOString());
    stored++;
  }

  const pending = (await cache.venueDrinkCandidates(username, filter)).length;
  const another = pending > 0;
  let note: string;
  if (rateStop) note = `Paused with ${pending} check-in(s) pending. ${resumeAdvice(rateStop, TOOL)}`;
  else if (another) note = `${pending} check-in(s) still pending — run ${TOOL} again to continue (max_calls per run).`;
  else note = 'Every selected venue\'s first/recent visit drink is cached; untappd_cache_has_visited lists them under matches[].drinks.';
  if (errors > 0) note += ` ${errors} fetch(es) failed and stay pending.`;

  return {
    username,
    api_calls: calls,
    stored,
    unavailable,
    errors,
    pending,
    another_run_needed: another,
    stopped_for_rate_limit: rateStop !== undefined,
    ...(rateStop ? { rate_limit: rateStop } : {}),
    ...(firstError ? { first_error: firstError } : {}),
    note,
  };
}
