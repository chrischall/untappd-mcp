import { UNTRUSTED_CONTENT_RULE, untrustedEnvelope } from '@chrischall/mcp-utils';

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
 * cut to at most 120 characters as a whole, title first. A title starting with
 * `-- ` or `\\` is escaped with one leading `\\`, so an item never reads as a
 * note. Read only from the fields a check-in record carries; a rating of 0 is
 * Untappd's "no rating".
 */
export function briefCheckinLine(item: unknown): string {
  const c = dict(item);
  const who = str(dict(c.user).user_name) ?? 'someone';
  const beer = str(dict(c.beer).beer_name) ?? 'a beer';
  const brewery = str(dict(c.brewery).brewery_name);
  const venue = str(dict(c.venue).venue_name);
  const raw = `${who}: ${beer}${brewery ? ` (${brewery})` : ''}${venue ? ` at ${venue}` : ''}`;
  // A title that could read as a note (`-- `) or lose a character to the host's one-backslash strip is escaped.
  const title = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const rating = typeof c.rating_score === 'number' && c.rating_score > 0 ? `rated ${c.rating_score}` : 'not rated';
  const tail = ` — ${isoInstant(c.created_at) ?? 'no date'} — ${rating}`;
  const room = BRIEF_MAX - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${shown}${tail}`;
}

/** Who writes the brief lines' text — the head of the untrusted-data envelope's note. */
const BRIEF_WHO_WROTE =
  'Check-in user names and beer, brewery and venue names are written by other Untappd users and breweries.';

/**
 * A `{ checkins: { items, pagination } }` response as brief lines, one per
 * check-in, plus `-- ` notes: `-- none` for an empty page, `-- more` when
 * Untappd returned an older-page cursor (`pagination.max_id`), and
 * `-- error: …` for a shape this view does not read.
 */
export function briefCheckinLines(resp: unknown): string[] {
  const box = dict(dict(resp).checkins);
  if (!Array.isArray(box.items)) {
    return ['-- error: Untappd answered in a shape this brief view does not read; ask with view "full"'];
  }
  if (box.items.length === 0) return ['-- none'];
  const lines = box.items.map(briefCheckinLine);
  const next = dict(box.pagination).max_id;
  if (typeof next === 'number' && next > 0) lines.push('-- more');
  return lines;
}

/**
 * The brief answer: the lines inside the fleet's untrusted-data envelope as
 * `data: string[]`, minified, note first — the text in them is other people's.
 */
export function briefCheckins(resp: unknown): string {
  return JSON.stringify(
    untrustedEnvelope(briefCheckinLines(resp), { note: `${BRIEF_WHO_WROTE} ${UNTRUSTED_CONTENT_RULE}` }),
  );
}
