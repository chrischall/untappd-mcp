import type { UntappdClient } from './client.js';

export interface QuotaClamp {
  /** The budget to actually spend. */
  budget: number;
  /** Calls left this hour per Untappd's last response, or null when unknown. */
  quota_remaining: number | null;
  /** True when the quota, not the caller's request, set the budget. */
  clamped: boolean;
}

/**
 * Cap a per-call API budget to the calls Untappd says are left this hour, so
 * two tools run back to back don't each plan as if they had the whole quota.
 * When the quota is unknown (no response has carried X-Ratelimit-Remaining)
 * the requested budget stands. `floor` keeps tools whose paging logic needs at
 * least one page from being handed zero.
 */
export function clampToQuota(client: UntappdClient, requested: number, floor = 0): QuotaClamp {
  // Test fakes and other stand-ins may not implement the getter at all.
  const remaining = (client as Partial<Pick<UntappdClient, 'quotaRemaining'>>).quotaRemaining ?? null;
  if (remaining === null || remaining >= requested) return { budget: requested, quota_remaining: remaining, clamped: false };
  return { budget: Math.max(floor, remaining), quota_remaining: remaining, clamped: true };
}
