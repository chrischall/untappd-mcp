import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import { client } from '../client.js';

const CheckinIdSchema = z.number().int().positive().describe('Untappd check-in id');

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

export function registerCheckinTools(server: McpServer): void {
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
    'untappd_checkin',
    {
      title: 'Check in a beer on Untappd',
      description:
        'Post a NEW beer check-in to YOUR Untappd account — this publishes to your public feed. Provide the beer id ' +
        '(bid) from untappd_search_beer; optionally a rating (0–5 in 0.25 steps), a shout (comment), and a venue via ' +
        'foursquare_id (from a venue result). Without confirm: true it returns a dry-run preview of the exact fields ' +
        'and makes NO network call; with confirm: true it posts. Photo attachment is not supported.',
      annotations: toolAnnotations({ title: 'Check in a beer on Untappd', readOnly: false, idempotent: false, openWorld: true }),
      inputSchema: {
        bid: z.number().int().positive().describe('Untappd beer id to check in (from untappd_search_beer)'),
        rating: RatingSchema.optional().describe('Rating 0–5 in 0.25 increments (omit for no rating)'),
        shout: z.string().max(2000).optional().describe('Optional shout / comment text for the check-in'),
        foursquare_id: z.string().optional().describe('Optional Foursquare venue id to tag the check-in location'),
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
    async ({ bid, rating, shout, foursquare_id, geolat, geolng, container_id, confirm }) => {
      const { timezone, gmt_offset } = localTimezone();
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
        is_photo: 'false',
        platform: 'ios',
      };
      if (confirm !== true) {
        return textResult({
          dryRun: true,
          action: 'checkin',
          form,
          note: 'Dry run — re-run with confirm: true to POST this check-in to your public Untappd feed.',
        });
      }
      const data = await client.write<{ checkin_id?: number }>('POST', '/checkin/add', { form });
      return textResult({ checked_in: true, checkin_id: data?.checkin_id, response: data });
    },
  );
}
