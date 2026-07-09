import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';

// The endpoint PATHS below are confirmed from the Untappd app's own JS bundle
// (`friend/request`, `friend/accept`, `friend/reject`, `friend/remove`). The
// HTTP method (POST) mirrors the other captured action-writes (toast/comment),
// but — unlike the rest of this server's writes — these were NOT live-verified
// against the API, because doing so would send real friend requests to / alter
// real relationships with other people. They are confirm-gated so nothing fires
// without an explicit confirm: true.

const TargetUidSchema = z
  .number()
  .int()
  .positive()
  .describe('The target user id (uid) — from a user profile (response.user.uid) or a friends-list item');

interface FriendAction {
  tool: string;
  path: string;
  title: string;
  verb: string;
  detail: string;
}

const ACTIONS: FriendAction[] = [
  {
    tool: 'untappd_add_friend',
    path: 'request',
    title: 'Send an Untappd friend request',
    verb: 'send a friend request to',
    detail: 'Sends a friend request to another user, who will be notified.',
  },
  {
    tool: 'untappd_accept_friend',
    path: 'accept',
    title: 'Accept an Untappd friend request',
    verb: 'accept the incoming friend request from',
    detail: 'Accepts an incoming friend request (see untappd_pending_friends for pending uids).',
  },
  {
    tool: 'untappd_reject_friend',
    path: 'reject',
    title: 'Reject an Untappd friend request',
    verb: 'reject the incoming friend request from',
    detail: 'Rejects/ignores an incoming friend request (see untappd_pending_friends for pending uids).',
  },
  {
    tool: 'untappd_remove_friend',
    path: 'remove',
    title: 'Remove an Untappd friend',
    verb: 'remove your friendship with',
    detail: 'Removes an existing friend, or cancels a friend request you sent.',
  },
];

export function registerFriendActionTools(server: McpServer, client: UntappdClient): void {
  for (const action of ACTIONS) {
    server.registerTool(
      action.tool,
      {
        title: action.title,
        description:
          `${action.detail} Acts on YOUR account and affects a real relationship with another person. ` +
          'Without confirm: true it returns a dry-run preview and makes NO network call; with confirm: true it ' +
          'performs the action. Note: this endpoint path is taken from the Untappd app but is not otherwise ' +
          'independently verified.',
        annotations: toolAnnotations({ title: action.title, readOnly: false, idempotent: true, openWorld: true }),
        inputSchema: {
          target_uid: TargetUidSchema,
          confirm: schemaConfirm,
        },
      },
      async ({ target_uid, confirm }) => {
        if (confirm !== true) {
          return textResult({
            dryRun: true,
            action: action.path,
            target_uid,
            note: `Dry run — re-run with confirm: true to ${action.verb} user ${target_uid}.`,
          });
        }
        const data = await client.write<{ result?: string }>('POST', `/friend/${action.path}/${target_uid}`);
        return textResult({ done: true, action: action.path, target_uid, result: data?.result });
      },
    );
  }
}
