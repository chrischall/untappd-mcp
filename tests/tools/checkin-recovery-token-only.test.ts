import { describe, it, expect, vi, afterAll } from 'vitest';
import { UnreachableError } from '@chrischall/mcp-utils';
import { UntappdClient } from '../../src/client.js';
import { registerCheckinTools } from '../../src/tools/checkin.js';
import { createTestHarness } from '../helpers.js';

// A token-only deployment (UNTAPPD_ACCESS_TOKEN, no UNTAPPD_USERNAME) has no
// loginName. A timed-out check-in must still be recoverable: the lookup uses
// Untappd's self form of user/checkins (no username → the token's own account).
const client = new UntappdClient({ token: 'T', clientId: 'C', clientSecret: 'S' });
vi.spyOn(client, 'loginName', 'get').mockReturnValue(null);
const write = vi.spyOn(client, 'write');
const get = vi.spyOn(client, 'get');

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text) as Record<string, unknown>;

describe('check-in timeout recovery without a configured username', () => {
  it('confirms the check-in Untappd did create via the self form of user/checkins', async () => {
    harness = await createTestHarness((server) => registerCheckinTools(server, client));
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    get.mockResolvedValueOnce({
      checkins: { items: [{ checkin_id: 777, created_at: new Date().toUTCString().replace('GMT', '+0000'), beer: { bid: 100 } }] },
    });
    const p1 = parse(await harness.callTool('untappd_checkin', { bid: 100 }));
    expect(p1.status).toBe('confirmation-required');
    const out = parse(await harness.callTool('untappd_checkin', { bid: 100, confirmToken: p1.confirmToken }));
    expect(get).toHaveBeenCalledWith('/user/checkins', { limit: 5 });
    expect(out.checked_in).toBe(true);
    expect(out.checkin_id).toBe(777);
    expect(out.recovered).toBe(true);
  });
});
