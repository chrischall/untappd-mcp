import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm, fileBlob, McpToolError, createHelpfulError, messageOf } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';

const CheckinIdSchema = z.number().int().positive().describe('Untappd check-in id');

// Keyed by the NORMALISED extension that photoExt() returns (jpeg → jpg), so
// there is no dead `jpeg` entry.
const PHOTO_CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png' };

function photoExt(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

// Untappd ratings are 0–5 in 0.25 increments; 0 (or omitted) means no rating.
const RatingSchema = z
  .number()
  .min(0)
  .max(5)
  .refine((r) => Math.round(r * 4) === r * 4, { message: 'rating must be a multiple of 0.25' });

function localTimezone(): { timezone: string; gmt_offset: number } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // getTimezoneOffset is minutes behind UTC (positive = behind), so negate for GMT offset in hours.
  const gmt_offset = -new Date().getTimezoneOffset() / 60;
  return { timezone, gmt_offset };
}

export function registerCheckinTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_toast',
    {
      title: 'Toast an Untappd check-in',
      description:
        "Toast (like) a check-in on YOUR account. This endpoint is a TOGGLE: calling it on a check-in you have " +
        'already toasted removes the toast. Without confirm: true it returns a dry-run preview and makes NO network ' +
        'call; with confirm: true it posts. Writes to your Untappd account and is visible to others.',
      annotations: toolAnnotations({ title: 'Toast an Untappd check-in', readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        checkin_id: CheckinIdSchema,
        confirm: schemaConfirm,
      },
    },
    async ({ checkin_id, confirm }) => {
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'toast',
          checkin_id,
          note: 'Dry run — re-run with confirm: true to toggle your toast on this check-in.',
        });
      }
      const data = await client.write<{ result?: string; like_type?: string }>('POST', `/checkin/toast/${checkin_id}`);
      return textResult({ toggled: true, checkin_id, result: data?.result, like_type: data?.like_type });
    },
  );

  server.registerTool(
    'untappd_add_comment',
    {
      title: 'Comment on an Untappd check-in',
      description:
        'Post a comment on a check-in from YOUR account. Without confirm: true it returns a dry-run preview and ' +
        'makes NO network call; with confirm: true it posts. Writes to your Untappd account and is visible to others.',
      annotations: toolAnnotations({ title: 'Comment on an Untappd check-in', readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        checkin_id: CheckinIdSchema,
        comment: z.string().min(1).max(2000).describe('Comment text to post'),
        confirm: schemaConfirm,
      },
    },
    async ({ checkin_id, comment, confirm }) => {
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'add_comment',
          checkin_id,
          comment,
          note: 'Dry run — re-run with confirm: true to post this comment to your Untappd account.',
        });
      }
      const data = await client.write('POST', `/checkin/addcomment/${checkin_id}`, { form: { comment } });
      return textResult({ posted: true, checkin_id, response: data });
    },
  );

  server.registerTool(
    'untappd_delete_comment',
    {
      title: 'Delete a comment from an Untappd check-in',
      description:
        'Delete one of YOUR comments by its comment id (the id from a check-in\'s comments list). Without ' +
        'confirm: true it returns a dry-run preview and makes NO network call; with confirm: true it deletes.',
      annotations: toolAnnotations({ title: 'Delete a comment from an Untappd check-in', readOnly: false, idempotent: true, openWorld: true }),
      inputSchema: {
        comment_id: z.number().int().positive().describe('Untappd comment id (from a check-in\'s comments.items)'),
        confirm: schemaConfirm,
      },
    },
    async ({ comment_id, confirm }) => {
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'delete_comment',
          comment_id,
          note: 'Dry run — re-run with confirm: true to delete this comment from your Untappd account.',
        });
      }
      const data = await client.write<{ result?: string }>('POST', `/checkin/deletecomment/${comment_id}`);
      return textResult({ deleted: true, comment_id, result: data?.result });
    },
  );

  server.registerTool(
    'untappd_delete_checkin',
    {
      title: 'Delete an Untappd check-in',
      description:
        'Permanently delete one of YOUR check-ins by its id. This is destructive and cannot be undone. Without ' +
        'confirm: true it returns a dry-run preview and makes NO network call; with confirm: true it deletes.',
      annotations: toolAnnotations({ title: 'Delete an Untappd check-in', readOnly: false, idempotent: true, openWorld: true }),
      inputSchema: {
        checkin_id: CheckinIdSchema,
        confirm: schemaConfirm,
      },
    },
    async ({ checkin_id, confirm }) => {
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'delete_checkin',
          checkin_id,
          note: 'Dry run — re-run with confirm: true to PERMANENTLY delete this check-in. This cannot be undone.',
        });
      }
      const data = await client.write<{ result?: string }>('POST', `/checkin/delete/${checkin_id}`);
      return textResult({ deleted: true, checkin_id, result: data?.result });
    },
  );

  server.registerTool(
    'untappd_checkin',
    {
      title: 'Check in a beer on Untappd',
      description:
        'Post a NEW beer check-in to YOUR Untappd account — this publishes to your public feed. Provide the beer id ' +
        '(bid) from untappd_search_beer; optionally a rating (0–5 in 0.25 steps), a shout (comment), a venue via ' +
        'foursquare_id, and a local photo via photo_path (JPEG/PNG). Without confirm: true it returns a dry-run ' +
        'preview of the exact fields and makes NO network call; with confirm: true it posts.',
      annotations: toolAnnotations({ title: 'Check in a beer on Untappd', readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        bid: z.number().int().positive().describe('Untappd beer id to check in (from untappd_search_beer)'),
        rating: RatingSchema.optional().describe('Rating 0–5 in 0.25 increments (omit for no rating)'),
        shout: z.string().max(2000).optional().describe('Optional shout / comment text for the check-in'),
        foursquare_id: z.string().optional().describe('Optional Foursquare venue id to tag the check-in location'),
        photo_path: z.string().optional().describe('Optional path to a local JPEG/PNG photo to attach to the check-in'),
        geolat: z.number().optional().describe('Optional latitude of the check-in'),
        geolng: z.number().optional().describe('Optional longitude of the check-in'),
        container_id: z
          .number()
          .int()
          .optional()
          .describe('Optional serving container id (e.g. 1 = draft, 2 = bottle, 3 = can)'),
        confirm: schemaConfirm,
      },
    },
    async ({ bid, rating, shout, foursquare_id, photo_path, geolat, geolng, container_id, confirm }) => {
      const { timezone, gmt_offset } = localTimezone();
      let ext: string | undefined;
      if (photo_path !== undefined) {
        ext = photoExt(photo_path);
        if (!(ext in PHOTO_CONTENT_TYPES)) {
          throw createHelpfulError(`Unsupported photo type "${ext || '(none)'}".`, {
            hint: 'Attach a .jpg, .jpeg, or .png file.',
          });
        }
      }
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
        is_photo: photo_path !== undefined ? 'true' : 'false',
        photo_file_ext: photo_path !== undefined ? ext : undefined,
        platform: 'ios',
      };
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'checkin',
          form,
          photo: photo_path !== undefined ? { path: photo_path, note: 'will be uploaded after the check-in is created' } : undefined,
          note: 'Dry run — re-run with confirm: true to POST this check-in to your public Untappd feed.',
        });
      }
      // Open the photo BEFORE creating the check-in, so a missing/unreadable
      // file fails fast without leaving an orphaned photo-less check-in behind.
      let blob: Blob | undefined;
      if (photo_path !== undefined) {
        if (!existsSync(photo_path)) throw new McpToolError(`Photo file not found: ${photo_path}`);
        blob = await fileBlob(photo_path); // file-backed, streamed — not heap-buffered
      }

      const data = await client.write<{
        checkin_id?: number;
        photo_upload?: { url?: string; destination_url?: string };
      }>('POST', '/checkin/add', { form });

      // Photo is a follow-up S3 upload keyed to the returned checkin_id, then an
      // uploadComplete call. The check-in already exists at this point, so a
      // photo failure is surfaced explicitly (photo_error) rather than thrown —
      // never silently dropped.
      let photo_attached = false;
      let photo_error: string | undefined;
      if (photo_path !== undefined) {
        if (data?.photo_upload?.url && data.checkin_id) {
          try {
            await client.putBinary(data.photo_upload.url, blob!, PHOTO_CONTENT_TYPES[ext!]);
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
      return textResult({
        checked_in: true,
        checkin_id: data?.checkin_id,
        photo_attached,
        ...(photo_error ? { photo_error } : {}),
        response: data,
      });
    },
  );
}
