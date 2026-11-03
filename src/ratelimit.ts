// Rate-limit tracking for the ~100 calls/hour Untappd v4 limit.
//
// Every response the client receives is recorded as an ApiCallObservation
// (time, status, and whatever X-Ratelimit-* / Retry-After headers it carried).
// The headers alone can't be trusted: the v4 API sends `X-Ratelimit-Remaining:
// 0` on EVERY successful response (observed live 2026-11-02), so a header-only
// reading would report the quota exhausted after the first call. The estimate
// therefore rests on a LOCAL count of calls in the rolling hour, and only takes
// the header into account once it has reported a live (non-zero) value — or
// when Untappd actually answered 429.
//
// The stdio server also persists observations into the shared cache file
// (`api_calls` table), so a fresh process — or a second one sharing the file —
// knows what was already spent this hour. `checkRateBudget` merges both views
// and is the guard every paging sync consults before each page, so it can stop
// cleanly with resume info instead of failing mid-batch on a 429.

import { readEnvVar, type RateLimitError } from '@chrischall/mcp-utils';
import type { UntappdClient } from './client.js';

export const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Untappd's documented per-token limit; override with UNTAPPD_RATE_LIMIT_PER_HOUR. */
export const DEFAULT_HOURLY_LIMIT = 100;
/** Calls the guard leaves unspent so interactive tools still work after a sync. */
export const DEFAULT_RESERVE = 2;

/** One API response as seen by the rate-limit tracker. Times are epoch ms. */
export interface ApiCallObservation {
  at: number;
  status: number;
  /** X-Ratelimit-Remaining, if present and numeric. */
  remaining: number | null;
  /** X-Ratelimit-Limit, if present and positive. */
  limit: number | null;
  /** X-Ratelimit-Reset as an absolute epoch-ms time, if present. */
  reset_at: number | null;
  /** Retry-After seconds, if present. */
  retry_after_s: number | null;
}

/** Rate-limit picture reported by untappd_cache_status and used by the guard. */
export interface RateLimitStatus {
  hourly_limit: number;
  /** Where hourly_limit came from: UNTAPPD_RATE_LIMIT_PER_HOUR, a response header, or the assumed default. */
  limit_source: 'env' | 'header' | 'assumed';
  calls_last_hour: number;
  estimated_remaining: number;
  /** The most recent X-Ratelimit-Remaining seen (raw). */
  header_remaining: number | null;
  /** False while the header has only ever said 0 on successes (the v4 behaviour) — then it is ignored. */
  header_remaining_trusted: boolean;
  header_reset_at: string | null;
  last_response_at: string | null;
  last_429_at: string | null;
  /** Set while a 429's Retry-After (or reset) has not yet elapsed. */
  blocked_until: string | null;
}

/** The guard's answer for "may a sync spend `needed` more calls now?". */
export interface RateGuardVerdict {
  ok: boolean;
  estimated_remaining: number;
  calls_last_hour: number;
  hourly_limit: number;
  reserve: number;
  /** When enough budget should be free again (null when ok, or unknown). */
  resume_at: string | null;
  resume_after_s: number | null;
  reason?: string;
}

/** Why and until when a sync stopped short — attached to sync summaries. */
export interface RateStop {
  reason: string;
  estimated_remaining?: number;
  calls_last_hour?: number;
  hourly_limit?: number;
  resume_at: string | null;
  resume_after_s: number | null;
}

function intHeader(h: Headers, name: string): number | null {
  const raw = h.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Build an observation from a response's status and headers. */
export function observeResponse(status: number, headers: Headers, now = Date.now()): ApiCallObservation {
  const limit = intHeader(headers, 'x-ratelimit-limit');
  const reset = intHeader(headers, 'x-ratelimit-reset');
  let reset_at: number | null = null;
  if (reset !== null) {
    if (reset > 1e12) reset_at = reset; // epoch ms
    else if (reset > 1e9) reset_at = reset * 1000; // epoch seconds
    else reset_at = now + reset * 1000; // seconds from now
  }
  const ra = intHeader(headers, 'retry-after');
  return {
    at: now,
    status,
    remaining: intHeader(headers, 'x-ratelimit-remaining'),
    limit: limit !== null && limit > 0 ? limit : null,
    reset_at,
    retry_after_s: ra !== null && ra > 0 ? ra : null,
  };
}

/** UNTAPPD_RATE_LIMIT_PER_HOUR, when set to a positive integer. */
export function configuredHourlyLimit(): number | null {
  const raw = readEnvVar('UNTAPPD_RATE_LIMIT_PER_HOUR');
  const n = raw === undefined || raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

interface Computed extends RateLimitStatus {
  /** Ascending call times in the window (for resume estimates). */
  times: number[];
  blockedUntilMs: number | null;
  headerBoundResetMs: number | null;
}

function compute(all: ApiCallObservation[], now: number, opts: { configuredLimit?: number | null }): Computed {
  const obs = all.filter((o) => o.at > now - RATE_WINDOW_MS).sort((a, b) => a.at - b.at);
  const latestWith = <K extends keyof ApiCallObservation>(k: K) => {
    for (let i = obs.length - 1; i >= 0; i--) if (obs[i][k] !== null) return obs[i];
    return undefined;
  };
  const headerLimit = latestWith('limit')?.limit ?? null;
  const configured = opts.configuredLimit ?? null;
  const hourly_limit = configured ?? headerLimit ?? DEFAULT_HOURLY_LIMIT;
  const limit_source = configured !== null ? 'env' : headerLimit !== null ? 'header' : 'assumed';

  const lastRemaining = latestWith('remaining');
  const headerRemaining = lastRemaining?.remaining ?? null;
  const headerLive = obs.some((o) => o.remaining !== null && o.remaining > 0);
  const resetMs = lastRemaining?.reset_at ?? null;
  const headerTrusted =
    lastRemaining !== undefined && (headerLive || lastRemaining.status === 429) && (resetMs === null || resetMs > now);

  let blockedUntilMs: number | null = null;
  let last429: number | null = null;
  for (const o of obs) {
    if (o.status !== 429) continue;
    last429 = o.at;
    const until =
      o.retry_after_s !== null
        ? o.at + o.retry_after_s * 1000
        : o.reset_at ?? (obs[0] ? obs[0].at + RATE_WINDOW_MS : o.at + RATE_WINDOW_MS);
    if (until > now && (blockedUntilMs === null || until > blockedUntilMs)) blockedUntilMs = until;
  }

  const local = hourly_limit - obs.length;
  let estimate = local;
  if (headerTrusted && headerRemaining !== null) estimate = Math.min(estimate, headerRemaining);
  if (blockedUntilMs !== null) estimate = 0;

  return {
    hourly_limit,
    limit_source,
    calls_last_hour: obs.length,
    estimated_remaining: Math.max(0, estimate),
    header_remaining: headerRemaining,
    header_remaining_trusted: headerTrusted,
    header_reset_at: iso(resetMs),
    last_response_at: iso(obs.length ? obs[obs.length - 1].at : null),
    last_429_at: iso(last429),
    blocked_until: iso(blockedUntilMs),
    times: obs.map((o) => o.at),
    blockedUntilMs,
    headerBoundResetMs: headerTrusted ? resetMs : null,
  };
}

/** The rate-limit picture for a set of observations (pure; for tests and the status tool). */
export function computeRateLimitStatus(
  obs: ApiCallObservation[],
  now: number,
  opts: { configuredLimit?: number | null },
): RateLimitStatus {
  const { times: _t, blockedUntilMs: _b, headerBoundResetMs: _h, ...status } = compute(obs, now, opts);
  return status;
}

/** In-memory record of this process's responses within the rolling hour. */
export class RateLimitTracker {
  private obs: ApiCallObservation[] = [];

  record(o: ApiCallObservation): void {
    this.obs.push(o);
    this.prune(o.at);
  }

  observations(now = Date.now()): ApiCallObservation[] {
    this.prune(now);
    return [...this.obs];
  }

  private prune(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    if (this.obs.length && this.obs[0].at <= cutoff) this.obs = this.obs.filter((o) => o.at > cutoff);
  }
}

/** The persisted call log, as the cache store exposes it (optional on CacheStore). */
export interface ApiCallLog {
  recordApiCalls?(rows: ApiCallObservation[]): Promise<void>;
  recentApiCalls?(sinceMs: number): Promise<ApiCallObservation[]>;
}

/** This process's observations merged with the shared cache log, de-duplicated. */
async function mergedObservations(client: UntappdClient, cache: ApiCallLog | undefined, now: number) {
  const tracker = (client as Partial<Pick<UntappdClient, 'rateLimit'>>).rateLimit;
  const mine = tracker?.observations(now) ?? [];
  let theirs: ApiCallObservation[] = [];
  try {
    theirs = (await cache?.recentApiCalls?.(now - RATE_WINDOW_MS)) ?? [];
  } catch {
    /* an unreadable log just means "this process's view only" */
  }
  // The shared log normally already holds this process's own calls (the stdio
  // server persists each one), so merge as a multiset: per identical
  // observation, keep the larger of the two counts rather than summing them.
  // Two genuinely separate calls in the same millisecond stay two.
  const key = (o: ApiCallObservation) => `${o.at}:${o.status}:${o.remaining}:${o.retry_after_s}`;
  const group = (xs: ApiCallObservation[]) => {
    const m = new Map<string, ApiCallObservation[]>();
    for (const o of xs) m.set(key(o), [...(m.get(key(o)) ?? []), o]);
    return m;
  };
  const a = group(mine);
  const b = group(theirs);
  const out: ApiCallObservation[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? [];
    const y = b.get(k) ?? [];
    out.push(...(x.length >= y.length ? x : y));
  }
  return out;
}

/** The current rate-limit picture (this process + the shared cache log). */
export async function rateLimitStatus(client: UntappdClient, cache: ApiCallLog | undefined): Promise<RateLimitStatus> {
  const now = Date.now();
  return computeRateLimitStatus(await mergedObservations(client, cache, now), now, {
    configuredLimit: configuredHourlyLimit(),
  });
}

/**
 * The stop-before-429 guard: may a sync spend `needed` more calls and still
 * leave `reserve` unspent? Paging syncs call it before EVERY page and stop
 * cleanly (progress is persisted per page) with `resume_at` when it says no.
 */
export async function checkRateBudget(
  client: UntappdClient,
  cache: ApiCallLog | undefined,
  opts: { needed?: number; reserve?: number } = {},
): Promise<RateGuardVerdict> {
  const needed = opts.needed ?? 1;
  const reserve = opts.reserve ?? DEFAULT_RESERVE;
  const now = Date.now();
  const c = compute(await mergedObservations(client, cache, now), now, { configuredLimit: configuredHourlyLimit() });
  const base = {
    estimated_remaining: c.estimated_remaining,
    calls_last_hour: c.calls_last_hour,
    hourly_limit: c.hourly_limit,
    reserve,
  };
  if (c.estimated_remaining - needed >= reserve) {
    return { ok: true, ...base, resume_at: null, resume_after_s: null };
  }
  let resumeMs: number | null = null;
  if (c.blockedUntilMs !== null) resumeMs = c.blockedUntilMs;
  else if (c.headerBoundResetMs !== null) resumeMs = c.headerBoundResetMs;
  else {
    // Rolling window: wait until enough of the oldest calls age out.
    const deficit = needed + reserve - (c.hourly_limit - c.calls_last_hour);
    if (deficit > 0 && deficit <= c.times.length) resumeMs = c.times[deficit - 1] + RATE_WINDOW_MS;
  }
  return {
    ok: false,
    ...base,
    resume_at: iso(resumeMs),
    resume_after_s: resumeMs === null ? null : Math.max(0, Math.ceil((resumeMs - now) / 1000)),
    reason:
      c.blockedUntilMs !== null
        ? 'Untappd answered 429 (rate limited) and its wait has not elapsed yet.'
        : `Stopped before Untappd's hourly rate limit: ~${c.estimated_remaining} of ${c.hourly_limit} calls left this hour, ${reserve} held in reserve.`,
  };
}

/** A guard verdict as a sync's stop record. */
export function stopFromVerdict(v: RateGuardVerdict): RateStop {
  return {
    reason: v.reason ?? 'rate limit',
    estimated_remaining: v.estimated_remaining,
    calls_last_hour: v.calls_last_hour,
    hourly_limit: v.hourly_limit,
    resume_at: v.resume_at,
    resume_after_s: v.resume_after_s,
  };
}

/** A 429 that slipped past the guard, as a sync's stop record. */
export function stopFrom429(e: RateLimitError, now = Date.now()): RateStop {
  const ra = e.retryAfterSeconds;
  return {
    reason: 'Untappd answered 429 (rate limited); progress up to the last full page is saved.',
    resume_at: ra !== undefined ? new Date(now + ra * 1000).toISOString() : null,
    resume_after_s: ra ?? null,
  };
}

/** One-line resume advice for a sync's `note`. */
export function resumeAdvice(stop: RateStop, tool: string): string {
  const when = stop.resume_at ? ` after ${stop.resume_at} (~${Math.ceil((stop.resume_after_s ?? 0) / 60)} min)` : ' later';
  return `${stop.reason} Progress is saved — run ${tool} again${when} to resume.`;
}
