/**
 * Context-group hints, published on each tool as `_meta.mint` (the mcp-host
 * context-groups contract, `mintHintSchema`). Inert data: a host that does not
 * read them sees an extra `_meta` key and nothing else. The shape is fixed by
 * the host's contract, so it is restated here rather than imported — this
 * server takes no dependency on mcp-host.
 *
 * Every Untappd tool sits in the `food` group. `subject` and `when` would name
 * THIS tool's own argument names (never values), but Untappd has no listable
 * set of the person's subjects (children, properties, accounts) and its feeds
 * take no date range, so no tool here declares either. `aliases` are the words
 * a person says — lowercase, at most 8, each at most 40 chars.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'food';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for an Untappd tool: every tool here is in the `food` domain. */
export function foodMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'food', intent, ...extra } };
}

const BRIEF_MAX = 120;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
function dict(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Untappd's RFC 2822 `created_at` as an ISO instant (to the second), or undefined when unparseable. */
function isoInstant(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * One check-in as one line, `<user>: <beer> (<brewery>) at <venue> — <ISO date | no date> — <rated N | not rated>`,
 * at most 120 characters (the title is shortened). Read only from the fields a
 * check-in record carries; a rating of 0 is Untappd's "no rating".
 */
export function briefCheckinLine(item: unknown): string {
  const c = dict(item);
  const who = str(dict(c.user).user_name) ?? 'someone';
  const beer = str(dict(c.beer).beer_name) ?? 'a beer';
  const brewery = str(dict(c.brewery).brewery_name);
  const venue = str(dict(c.venue).venue_name);
  const title = `${who}: ${beer}${brewery ? ` (${brewery})` : ''}${venue ? ` at ${venue}` : ''}`;
  const rating = typeof c.rating_score === 'number' && c.rating_score > 0 ? `rated ${c.rating_score}` : 'not rated';
  const tail = ` — ${isoInstant(c.created_at) ?? 'no date'} — ${rating}`;
  const room = BRIEF_MAX - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${shown}${tail}`;
}

/** A `{ checkins: { items } }` response as brief lines, one per check-in (none for an empty or unexpected page). */
export function briefCheckins(resp: unknown): string {
  const items = dict(dict(resp).checkins).items;
  return Array.isArray(items) ? items.map(briefCheckinLine).join('\n') : '';
}
