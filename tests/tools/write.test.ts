import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerCheckinTools } from '../../src/tools/checkin.js';
import { registerWishlistTools } from '../../src/tools/wishlist.js';
import { createTestHarness } from '../helpers.js';

const write = vi.spyOn(client, 'write').mockResolvedValue(undefined as never);

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => write.mockClear());
afterAll(async () => {
  if (harness) await harness.close();
});

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('write tools (confirm-gated)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerCheckinTools(server);
      registerWishlistTools(server);
    });
  });

  it('toast without confirm is a dry run and makes NO network call', async () => {
    const r = await harness.callTool('untappd_toast', { checkin_id: 42 });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('toast with confirm posts to the toast endpoint', async () => {
    write.mockResolvedValueOnce({ result: 'success', like_type: 'toast' });
    const r = await harness.callTool('untappd_toast', { checkin_id: 42, confirm: true });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/toast/42');
    expect(parse(r as never).toggled).toBe(true);
  });

  it('add_comment without confirm is a dry run', async () => {
    const r = await harness.callTool('untappd_add_comment', { checkin_id: 42, comment: 'nice' });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('add_comment with confirm posts the comment form', async () => {
    write.mockResolvedValueOnce({});
    await harness.callTool('untappd_add_comment', { checkin_id: 42, comment: 'nice', confirm: true });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/addcomment/42', { form: { comment: 'nice' } });
  });

  it('delete_comment without confirm is a dry run', async () => {
    const r = await harness.callTool('untappd_delete_comment', { comment_id: 89011936 });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('delete_comment with confirm posts to deletecomment', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await harness.callTool('untappd_delete_comment', { comment_id: 89011936, confirm: true });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/deletecomment/89011936');
    expect(parse(r as never).deleted).toBe(true);
  });

  it('checkin without confirm previews the exact form and makes NO network call', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, rating: 4.25, shout: 'great' });
    const out = parse(r as never);
    expect(out.dryRun).toBe(true);
    const form = out.form as Record<string, unknown>;
    expect(form.bid).toBe(100);
    expect(form.rating).toBe('4.25');
    expect(form.shout).toBe('great');
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin with confirm posts to /checkin/add with a formatted rating', async () => {
    write.mockResolvedValueOnce({ checkin_id: 555 });
    const r = await harness.callTool('untappd_checkin', { bid: 100, rating: 4, confirm: true });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/add', expect.objectContaining({ form: expect.objectContaining({ bid: 100, rating: '4.00' }) }));
    expect(parse(r as never).checked_in).toBe(true);
  });

  it('checkin rejects a rating that is not a 0.25 multiple', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, rating: 4.1, confirm: true });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('wishlist_add without confirm is a dry run', async () => {
    const r = await harness.callTool('untappd_wishlist_add', { bid: 3839 });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('wishlist_add with confirm hits /user/wishlist/add', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await harness.callTool('untappd_wishlist_add', { bid: 3839, confirm: true });
    expect(write).toHaveBeenCalledWith('GET', '/user/wishlist/add', { query: { bid: 3839 } });
    expect(parse(r as never).added).toBe(true);
  });

  it('wishlist_remove without confirm is a dry run', async () => {
    const r = await harness.callTool('untappd_wishlist_remove', { bid: 3839 });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('wishlist_remove with confirm hits /user/wishlist/delete', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await harness.callTool('untappd_wishlist_remove', { bid: 3839, confirm: true });
    expect(write).toHaveBeenCalledWith('GET', '/user/wishlist/delete', { query: { bid: 3839 } });
    expect(parse(r as never).removed).toBe(true);
  });
});
