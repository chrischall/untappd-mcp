import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UntappdClient } from '../../src/client.js';
import { registerFriendActionTools } from '../../src/tools/friends.js';
import { createTestHarness } from '../helpers.js';

const client = new UntappdClient();
const write = vi.spyOn(client, 'write').mockResolvedValue(undefined as never);

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => write.mockClear());
afterAll(async () => {
  if (harness) await harness.close();
});

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const CASES: [string, string][] = [
  ['untappd_add_friend', 'request'],
  ['untappd_accept_friend', 'accept'],
  ['untappd_reject_friend', 'reject'],
  ['untappd_remove_friend', 'remove'],
];

describe('friend action tools (confirm-gated)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerFriendActionTools(server, client));
  });

  for (const [tool, path] of CASES) {
    it(`${tool} without confirm is a dry run (no network call)`, async () => {
      const r = await harness.callTool(tool, { target_uid: 42 });
      expect(parse(r as never).dryRun).toBe(true);
      expect(write).not.toHaveBeenCalled();
    });

    it(`${tool} with confirm POSTs to /friend/${path}/{uid}`, async () => {
      write.mockResolvedValueOnce({ result: 'success' });
      const r = await harness.callTool(tool, { target_uid: 42, confirm: true });
      expect(write).toHaveBeenCalledWith('POST', `/friend/${path}/42`);
      expect(parse(r as never).done).toBe(true);
    });
  }
});
