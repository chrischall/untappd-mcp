import { realpathSync, statSync } from 'node:fs';
import { delimiter, extname } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  McpToolError,
  assertPathWithinRoots,
  createHelpfulError,
  fileBlob,
  messageOf,
  minifiedResult,
  readEnvVar,
  readFileHead,
  sniffMimeBytes,
  toolAnnotations,
  UnreachableError,
} from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { CONFIRM_FLOW, confirmWrite } from './confirm.js';

const CheckinIdSchema = z.number().int().positive().describe('Untappd check-in id');

// Keyed by the NORMALISED extension that photoExt() returns (jpeg → jpg), so
// there is no dead `jpeg` entry.
const PHOTO_CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png' };

function photoExt(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

// Far above any phone photo; a file this big is not a beer picture.
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

interface CheckedPhoto {
  /** Real absolute path (symlinks resolved) — what will actually be read. */
  path: string;
  size_bytes: number;
  ext: string;
  content_type: string;
}

/** UNTAPPD_PHOTO_DIR (one or more dirs, split on the platform path delimiter). */
function photoRoots(): string[] | undefined {
  const raw = readEnvVar('UNTAPPD_PHOTO_DIR');
  const roots = raw?.split(delimiter).filter(Boolean);
  return roots && roots.length > 0 ? roots : undefined;
}

/**
 * Vet a photo before it can be published to the public feed. photo_path is a
 * free-form, model-supplied path, so an injected instruction could aim it at
 * any file with an image-like name. Require the bytes to BE a JPEG/PNG that
 * matches the extension, cap the size, honour the optional UNTAPPD_PHOTO_DIR
 * allow-list, and return the resolved path + size so the preview shows a human
 * exactly which file would be uploaded. Errors never echo the path back.
 */
async function checkPhoto(photoPath: string): Promise<CheckedPhoto> {
  const ext = photoExt(photoPath);
  if (!(ext in PHOTO_CONTENT_TYPES)) {
    throw createHelpfulError(`Unsupported photo type "${ext || '(none)'}".`, {
      hint: 'Attach a .jpg, .jpeg, or .png file.',
    });
  }
  const roots = photoRoots();
  if (roots) {
    try {
      assertPathWithinRoots(photoPath, roots);
    } catch {
      throw createHelpfulError('The photo is outside the allowed photo directory.', {
        hint: 'UNTAPPD_PHOTO_DIR restricts which files can be attached to a check-in.',
      });
    }
  }
  let real: string;
  let size: number;
  try {
    real = realpathSync(photoPath);
    const st = statSync(real);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    throw new McpToolError('Photo file not found or not readable.');
  }
  if (size > MAX_PHOTO_BYTES) {
    throw createHelpfulError(`Photo is too large (${size} bytes; the limit is ${MAX_PHOTO_BYTES}).`, {
      hint: 'Attach a normal-sized JPEG or PNG photo.',
    });
  }
  const sniffed = sniffMimeBytes(await readFileHead(real, 16));
  if (sniffed !== PHOTO_CONTENT_TYPES[ext]) {
    throw createHelpfulError(
      sniffed === 'image/jpeg' || sniffed === 'image/png'
        ? `Photo content (${sniffed}) does not match its .${ext} extension.`
        : 'The file is not a JPEG or PNG image.',
      { hint: 'Attach a real .jpg/.jpeg or .png photo.' },
    );
  }
  return { path: real, size_bytes: size, ext, content_type: sniffed };
}

// Untappd ratings are 0–5 in 0.25 increments; 0 (or omitted) means no rating.
const RatingSchema = z
  .number()
  .min(0)
  .max(5)
  .refine((r) => Math.round(r * 4) === r * 4, { message: 'rating must be a multiple of 0.25' });

/** GMT offset in hours of an IANA zone at `at` (DST-aware), e.g. 5.5 for Asia/Kolkata. */
function gmtOffsetHours(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? '');
  if (!m) return 0; // plain "GMT"
  const hours = Number(m[2]) + Number(m[3] ?? 0) / 60;
  return m[1] === '-' ? -hours : hours;
}

/**
 * The zone the check-in is stamped with: the caller's `timezone`, else
 * UNTAPPD_TIMEZONE, else the server process's own zone. The process zone is
 * only right when the server runs on the drinker's own machine — a hosted
 * connector's process is typically UTC, which would stamp an evening check-in
 * into the next day.
 */
function checkinTimezone(requested: string | undefined): { timezone: string; gmt_offset: number } {
  const timezone =
    requested ?? readEnvVar('UNTAPPD_TIMEZONE') ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  try {
    return { timezone, gmt_offset: gmtOffsetHours(timezone, new Date()) };
  } catch {
    throw createHelpfulError(`Unknown timezone "${timezone}".`, {
      hint: 'Pass an IANA timezone name such as "America/New_York" or "Europe/London".',
    });
  }
}

// How far before the POST a recovered check-in's created_at may fall and still
// count as the one this call made. Only a small allowance for Untappd's
// whole-second created_at and modest clock skew: a wider window would match an
// earlier same-beer check-in (e.g. a prior timed-out attempt) and wrongly report
// it as this call's — telling the caller not to retry a check-in that never landed.
const RECOVERY_WINDOW_MS = 30_000;

/**
 * Run a NON-idempotent write. A transport failure or timeout (UnreachableError)
 * may fire after Untappd already received and applied the request, so it is
 * reported as "outcome unknown" — with how to check — rather than "unreachable",
 * which invites a blind retry that double-posts (or, for a toggle, undoes it).
 */
async function nonIdempotentWrite<T>(run: () => Promise<T>, unknownOutcome: string): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof UnreachableError) throw new McpToolError(unknownOutcome);
    throw e;
  }
}

/**
 * After an outcome-unknown /checkin/add, look for the check-in it may have made:
 * the caller's own most recent check-ins, same beer, created since just before
 * the POST. Returns its id only when exactly one matches; null when none does,
 * when more than one does (it can't tell which is this call's), or when the
 * lookup fails — each of which the caller reports as an unknown outcome.
 */
async function findRecentCheckin(client: UntappdClient, bid: number, sentAt: number): Promise<number | null> {
  const self = client.loginName;
  if (!self) return null;
  try {
    const data = await client.get<{ checkins?: { items?: unknown[] } }>(
      `/user/checkins/${encodeURIComponent(self)}`,
      { limit: 5 },
    );
    const matches: number[] = [];
    for (const it of data?.checkins?.items ?? []) {
      const c = it as { checkin_id?: number; created_at?: string; beer?: { bid?: number } };
      const at = Date.parse(c.created_at ?? '');
      if (c.beer?.bid === bid && typeof c.checkin_id === 'number' && at >= sentAt - RECOVERY_WINDOW_MS) {
        matches.push(c.checkin_id);
      }
    }
    if (matches.length === 1) return matches[0];
  } catch {
    /* can't verify — the caller reports the outcome as unknown */
  }
  return null;
}

export function registerCheckinTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_toast',
    {
      title: 'Toast an Untappd check-in',
      description:
        "Toast (like) a check-in on YOUR account. This endpoint is a TOGGLE: calling it on a check-in you have " +
        `already toasted removes the toast. Writes to your Untappd account and is visible to others. ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: 'Toast an Untappd check-in', readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        checkin_id: CheckinIdSchema,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ checkin_id, confirmToken }, ctx) => {
      const request = { method: 'POST', path: `/checkin/toast/${checkin_id}` };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_toast',
        action: 'untappd.toast',
        message: 'Review and confirm toggling your toast on this Untappd check-in:',
        confirmToken,
        target: checkin_id,
        payload: request,
        preview: {
          action: 'toast',
          checkin_id,
          ...request,
          note: 'Toggles your toast on this check-in (removes it if you have already toasted).',
        },
      });
      if (gate) return gate;
      const data = await nonIdempotentWrite(
        () => client.write<{ result?: string; like_type?: string }>('POST', `/checkin/toast/${checkin_id}`),
        `Untappd did not answer the toast request for check-in ${checkin_id} in time, so it may or may not have ` +
          'been applied. Toast is a TOGGLE: retrying could remove a toast that did land. Check with ' +
          `untappd_checkin_info (checkin_id ${checkin_id}) before retrying.`,
      );
      return minifiedResult({ toggled: true, checkin_id, result: data?.result, like_type: data?.like_type });
    },
  );

  server.registerTool(
    'untappd_add_comment',
    {
      title: 'Comment on an Untappd check-in',
      description:
        'Post a comment on a check-in from YOUR account. Writes to your Untappd account and is visible to others. ' +
        CONFIRM_FLOW,
      annotations: toolAnnotations({ title: 'Comment on an Untappd check-in', readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        checkin_id: CheckinIdSchema,
        comment: z.string().min(1).max(2000).describe('Comment text to post'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ checkin_id, comment, confirmToken }, ctx) => {
      const request = { method: 'POST', path: `/checkin/addcomment/${checkin_id}`, form: { comment } };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_add_comment',
        action: 'untappd.add_comment',
        message: 'Review and confirm posting this comment from your Untappd account:',
        confirmToken,
        target: checkin_id,
        payload: request,
        preview: {
          action: 'add_comment',
          checkin_id,
          comment,
          ...request,
          note: 'Posts this comment to the check-in from your Untappd account, visible to others.',
        },
      });
      if (gate) return gate;
      const data = await nonIdempotentWrite(
        () => client.write('POST', `/checkin/addcomment/${checkin_id}`, { form: { comment } }),
        `Untappd did not answer in time, so the comment may have been posted already. Check the comments with ` +
          `untappd_checkin_info (checkin_id ${checkin_id}) before retrying, or it may be posted twice.`,
      );
      return minifiedResult({ posted: true, checkin_id, response: data });
    },
  );

  server.registerTool(
    'untappd_delete_comment',
    {
      title: 'Delete a comment from an Untappd check-in',
      description:
        `Delete one of YOUR comments by its comment id (the id from a check-in's comments list). ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: 'Delete a comment from an Untappd check-in', readOnly: false, idempotent: true, openWorld: true, destructive: true }),
      inputSchema: z.object({
        comment_id: z.number().int().positive().describe('Untappd comment id (from a check-in\'s comments.items)'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ comment_id, confirmToken }, ctx) => {
      const request = { method: 'POST', path: `/checkin/deletecomment/${comment_id}` };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_delete_comment',
        action: 'untappd.delete_comment',
        message: 'Review and confirm deleting this comment from your Untappd account:',
        confirmToken,
        target: comment_id,
        payload: request,
        preview: { action: 'delete_comment', comment_id, ...request, note: 'Deletes this comment from your Untappd account.' },
      });
      if (gate) return gate;
      const data = await client.write<{ result?: string }>('POST', `/checkin/deletecomment/${comment_id}`);
      return minifiedResult({ deleted: true, comment_id, result: data?.result });
    },
  );

  server.registerTool(
    'untappd_delete_checkin',
    {
      title: 'Delete an Untappd check-in',
      description:
        `Permanently delete one of YOUR check-ins by its id. This is destructive and cannot be undone. ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: 'Delete an Untappd check-in', readOnly: false, idempotent: true, openWorld: true, destructive: true }),
      inputSchema: z.object({
        checkin_id: CheckinIdSchema,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ checkin_id, confirmToken }, ctx) => {
      const request = { method: 'POST', path: `/checkin/delete/${checkin_id}` };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_delete_checkin',
        action: 'untappd.delete_checkin',
        message: 'Review and confirm PERMANENTLY deleting this Untappd check-in:',
        confirmToken,
        target: checkin_id,
        payload: request,
        preview: {
          action: 'delete_checkin',
          checkin_id,
          ...request,
          note: 'PERMANENTLY deletes this check-in. This cannot be undone.',
        },
      });
      if (gate) return gate;
      const data = await client.write<{ result?: string }>('POST', `/checkin/delete/${checkin_id}`);
      return minifiedResult({ deleted: true, checkin_id, result: data?.result });
    },
  );

  server.registerTool(
    'untappd_checkin',
    {
      title: 'Check in a beer on Untappd',
      description:
        'Post a NEW beer check-in to YOUR Untappd account — this publishes to your public feed. Provide the beer id ' +
        '(bid) from untappd_search_beer; optionally a rating (0–5 in 0.25 steps), a shout (comment), a venue via ' +
        'foursquare_id, and a local photo via photo_path (JPEG/PNG). The preview shows the exact fields and photo ' +
        `that will be posted. ${CONFIRM_FLOW}`,
      annotations: toolAnnotations({ title: 'Check in a beer on Untappd', readOnly: false, idempotent: false, openWorld: true, destructive: false }),
      inputSchema: z.object({
        bid: z.number().int().positive().describe('Untappd beer id to check in (from untappd_search_beer)'),
        rating: RatingSchema.optional().describe('Rating 0–5 in 0.25 increments (omit for no rating)'),
        shout: z.string().max(2000).optional().describe('Optional shout / comment text for the check-in'),
        foursquare_id: z.string().optional().describe('Optional Foursquare venue id to tag the check-in location'),
        photo_path: z
          .string()
          .optional()
          .describe(
            'Optional path to a local JPEG/PNG photo (max 15 MB) to attach — it is published publicly. Only use a ' +
              'file the user explicitly chose; the preview shows the resolved path and size for them to confirm.',
          ),
        geolat: z.number().optional().describe('Optional latitude of the check-in'),
        geolng: z.number().optional().describe('Optional longitude of the check-in'),
        container_id: z
          .number()
          .int()
          .optional()
          .describe('Optional serving container id (e.g. 1 = draft, 2 = bottle, 3 = can)'),
        timezone: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The drinker's IANA timezone (e.g. America/New_York), which sets the check-in's local time. Defaults to " +
              "UNTAPPD_TIMEZONE, else the server's own zone — which on a hosted connector is usually UTC, so pass it " +
              'when you know where the user is.',
          ),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ bid, rating, shout, foursquare_id, photo_path, geolat, geolng, container_id, timezone: requestedTz, confirmToken }, ctx) => {
      const { timezone, gmt_offset } = checkinTimezone(requestedTz);
      // Vetted on every call, so the preview names the exact file (resolved path
      // + size) that will be published — and a file that changes between the
      // preview and the confirmed call no longer matches the token.
      const photo = photo_path !== undefined ? await checkPhoto(photo_path) : undefined;
      const form: Record<string, string | number | undefined> = {
        bid,
        rating: rating !== undefined ? rating.toFixed(2) : undefined,
        shout: shout || undefined,
        foursquare_id,
        geolat,
        geolng,
        container_id,
        timezone,
        gmt_offset,
        is_photo: photo ? 'true' : 'false',
        photo_file_ext: photo?.ext,
        platform: 'ios',
      };
      const request = { method: 'POST', path: '/checkin/add', form };
      const gate = await confirmWrite(ctx, {
        tool: 'untappd_checkin',
        action: 'untappd.checkin',
        message: 'Review and confirm posting this check-in to your public Untappd feed:',
        confirmToken,
        target: bid,
        payload: { ...request, photo },
        preview: {
          action: 'checkin',
          ...request,
          photo: photo ? { ...photo, note: 'this exact file will be uploaded PUBLICLY after the check-in is created' } : undefined,
          note: 'POSTs this check-in to your public Untappd feed.',
        },
      });
      if (gate) return gate;
      // Open the photo BEFORE creating the check-in, so a missing/unreadable
      // file fails fast without leaving an orphaned photo-less check-in behind.
      let blob: Blob | undefined;
      if (photo) {
        // file-backed, streamed — not heap-buffered; re-checks the size cap/roots at open.
        blob = await fileBlob(photo.path, { maxBytes: MAX_PHOTO_BYTES, label: 'Photo', allowedRoots: photoRoots() });
      }

      type AddResponse = { checkin_id?: number; photo_upload?: { url?: string; destination_url?: string } };
      const sentAt = Date.now();
      let data: AddResponse;
      try {
        data = await client.write<AddResponse>('POST', '/checkin/add', { form });
      } catch (e) {
        if (!(e instanceof UnreachableError)) throw e;
        // The POST may have landed before the connection failed. Look before
        // reporting failure: a retry of a check-in that DID land double-posts it
        // to the public feed (and double-counts stats and badges).
        const found = await findRecentCheckin(client, bid, sentAt);
        if (found === null) {
          throw new McpToolError(
            'Untappd did not answer the check-in request in time, so the check-in may have been created anyway ' +
              '(it could not be confirmed either way). Look at your latest check-ins with untappd_user_checkins ' +
              'before retrying — retrying a check-in that did land posts it twice.',
          );
        }
        return minifiedResult({
          checked_in: true,
          checkin_id: found,
          recovered: true,
          photo_attached: false,
          ...(photo
            ? { photo_error: `Check-in ${found} was created, but its photo upload URL was lost with the timed-out response, so no photo was attached.` }
            : {}),
          note: 'Untappd did not answer in time, but the check-in was found on your account — it was created. Do not retry.',
        });
      }

      // Photo is a follow-up S3 upload keyed to the returned checkin_id, then an
      // uploadComplete call. The check-in already exists at this point, so a
      // photo failure is surfaced explicitly (photo_error) rather than thrown —
      // never silently dropped.
      let photo_attached = false;
      let photo_error: string | undefined;
      if (photo) {
        if (data?.photo_upload?.url && data.checkin_id) {
          try {
            await client.putBinary(data.photo_upload.url, blob!, photo.content_type);
            await client.write('POST', '/photo/uploadComplete', {
              form: { checkin_id: data.checkin_id, destination_url: data.photo_upload.destination_url },
            });
            photo_attached = true;
          } catch (e) {
            photo_error = `Check-in ${data.checkin_id} was created, but attaching the photo failed: ${messageOf(e)}. Retry attaching, or remove it with untappd_delete_checkin.`;
          }
        } else {
          photo_error = `Check-in ${data?.checkin_id} was created, but Untappd returned no photo upload URL, so no photo was attached.`;
        }
      }
      return minifiedResult({
        checked_in: true,
        checkin_id: data?.checkin_id,
        photo_attached,
        ...(photo_error ? { photo_error } : {}),
        response: data,
      });
    },
  );
}
