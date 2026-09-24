import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { confirmTokenParam, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { CONFIRM_FLOW, confirmWrite } from './confirm.js';

// The endpoint PATHS below are confirmed from the Untappd app's own JS bundle
// (`friend/request`, `friend/accept`, `friend/reject`, `friend/remove`). The
// HTTP method (POST) mirrors the other captured action-writes (toast/comment),
// but — unlike the rest of this server's writes — these were NOT live-verified
// against the API, because doing so would send real friend requests to / alter
// real relationships with other people. They are confirmation-gated so nothing
// fires without the user approving the exact request first.

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
          `${CONFIRM_FLOW} Note: this endpoint path is taken from the Untappd app but is not otherwise ` +
          'independently verified.',
        // All four reach ANOTHER PERSON — the description says so itself: "affects
        // a real relationship with another person". A friend request cannot be
        // un-sent, and a rejection cannot be un-rejected, so none of them has an
        // inverse in this tool set.
        annotations: toolAnnotations({ title: action.title, readOnly: false, idempotent: true, openWorld: true, destructive: true }),
        inputSchema: z.object({
          target_uid: TargetUidSchema,
          confirmToken: confirmTokenParam,
        }),
      },
      async ({ target_uid, confirmToken }, ctx) => {
        const request = { method: 'POST', path: `/friend/${action.path}/${target_uid}` };
        const gate = await confirmWrite(ctx, {
          tool: action.tool,
          action: `untappd.friend_${action.path}`,
          message: `Review and confirm: ${action.verb} Untappd user ${target_uid}.`,
          confirmToken,
          target: target_uid,
          payload: request,
          preview: { action: action.path, target_uid, ...request, note: `Will ${action.verb} user ${target_uid}.` },
        });
        if (gate) return gate;
        const data = await client.write<{ result?: string }>('POST', `/friend/${action.path}/${target_uid}`);
        return minifiedResult({ done: true, action: action.path, target_uid, result: data?.result });
      },
    );
  }
}
