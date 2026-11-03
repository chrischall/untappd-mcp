import { createHelpfulError } from '@chrischall/mcp-utils';
import type { CacheStore } from './store.js';

/**
 * How a group has-had check picks beers:
 * - `none_had`: new to EVERYONE in the group (nobody has had it);
 * - `any_not_had`: at least one member still hasn't had it.
 */
export type MultiUserMode = 'none_had' | 'any_not_had';
export const MULTI_USER_MODES = ['none_had', 'any_not_had'] as const;
export const DEFAULT_MULTI_USER_MODE: MultiUserMode = 'none_had';
/** Most usernames one group check accepts. */
export const MAX_GROUP_USERS = 10;

export interface GroupHad {
  username: string;
  count: number;
  last_date: string | null;
  best_rating: number | null;
}

export interface GroupVerdict {
  bid: number;
  /** True when the bid satisfies the mode. */
  qualifies: boolean;
  had_by: GroupHad[];
  not_had_by: string[];
}

/**
 * The users a cache read is about: `usernames` (deduped case-insensitively,
 * first spelling kept) when given, else `username`, else the configured login.
 * Passing both `username` and `usernames` is ambiguous and rejected.
 */
export function resolveUsers(username: string | undefined, usernames: string[] | undefined, loginName: string | null): string[] {
  if (usernames && usernames.length > 0) {
    if (username !== undefined) {
      throw createHelpfulError('Pass either username or usernames, not both.', {
        hint: 'For a group check put every user in usernames (include yourself explicitly).',
      });
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of usernames) {
      const k = u.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
    return out;
  }
  const u = username ?? loginName;
  if (!u) {
    throw createHelpfulError('No username given and no configured account to fall back to.', {
      hint: 'Pass `username` (or `usernames`), or set UNTAPPD_USERNAME so cache tools default to your own account.',
    });
  }
  return [u];
}

/**
 * Group has-had over the cache only: one batched {@link CacheStore.hasHadMany}
 * per user, then each bid (deduped, input order kept) is marked against `mode`.
 */
export async function multiHasHad(
  cache: CacheStore,
  usernames: string[],
  bids: number[],
  mode: MultiUserMode,
): Promise<Map<number, GroupVerdict>> {
  const candidates = [...new Set(bids)];
  const out = new Map<number, GroupVerdict>();
  for (const bid of candidates) out.set(bid, { bid, qualifies: false, had_by: [], not_had_by: [] });
  for (const user of usernames) {
    const verdicts = await cache.hasHadMany(user, candidates);
    for (const bid of candidates) {
      const v = verdicts.get(bid);
      const g = out.get(bid)!;
      if (v?.had) g.had_by.push({ username: user, count: v.count, last_date: v.last_date, best_rating: v.best_rating });
      else g.not_had_by.push(user);
    }
  }
  for (const g of out.values()) {
    g.qualifies = mode === 'none_had' ? g.had_by.length === 0 : g.not_had_by.length > 0;
  }
  return out;
}
