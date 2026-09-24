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

describe('friend action tools (confirm-token gated)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerFriendActionTools(server, client));
  });

  for (const [tool, path] of CASES) {
    it(`${tool} phase 1 returns a preview + confirmToken and makes NO network call`, async () => {
      const r = await harness.callTool(tool, { target_uid: 42 });
      const out = parse(r as never);
      expect(out.status).toBe('confirmation-required');
      expect(typeof out.confirmToken).toBe('string');
      const preview = out.preview as Record<string, unknown>;
      expect(preview.action).toBe(path);
      expect(preview.target_uid).toBe(42);
      expect(preview.method).toBe('POST');
      expect(preview.path).toBe(`/friend/${path}/42`);
      expect(write).not.toHaveBeenCalled();
    });

    it(`${tool} phase 2 with the token POSTs to /friend/${path}/{uid} exactly once`, async () => {
      const p1 = parse((await harness.callTool(tool, { target_uid: 42 })) as never);
      expect(write).not.toHaveBeenCalled();
      write.mockResolvedValueOnce({ result: 'success' });
      const r = await harness.callTool(tool, { target_uid: 42, confirmToken: p1.confirmToken });
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('POST', `/friend/${path}/42`);
      expect(parse(r as never).done).toBe(true);
    });
  }

  it('refuses a token issued for a different user (TOKEN_INVALID) and does not act', async () => {
    const p1 = parse((await harness.callTool('untappd_add_friend', { target_uid: 42 })) as never);
    const r = await harness.callTool('untappd_add_friend', { target_uid: 43, confirmToken: p1.confirmToken });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(parse(r as never).error).toBe('TOKEN_INVALID');
    expect(write).not.toHaveBeenCalled();
  });
});
