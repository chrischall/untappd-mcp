import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerCheckinTools } from '../../src/tools/checkin.js';
import { registerWishlistTools } from '../../src/tools/wishlist.js';
import { createTestHarness } from '../helpers.js';

const write = vi.spyOn(client, 'write').mockResolvedValue(undefined as never);
const putBinary = vi.spyOn(client, 'putBinary').mockResolvedValue(undefined);

const TMP_JPG = join(tmpdir(), 'untappd-test-photo.jpg');
writeFileSync(TMP_JPG, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  write.mockClear();
  putBinary.mockClear();
});
afterAll(async () => {
  if (harness) await harness.close();
  rmSync(TMP_JPG, { force: true });
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

  it('checkin with a photo previews the photo path on dry run (no upload)', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
    const out = parse(r as never);
    expect(out.dryRun).toBe(true);
    expect((out.form as Record<string, unknown>).is_photo).toBe('true');
    expect((out.form as Record<string, unknown>).photo_file_ext).toBe('jpg');
    expect(write).not.toHaveBeenCalled();
    expect(putBinary).not.toHaveBeenCalled();
  });

  it('checkin rejects an unsupported photo type', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: '/tmp/nope.gif', confirm: true });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin with a photo runs the 3-step upload flow', async () => {
    write
      .mockResolvedValueOnce({ checkin_id: 777, photo_upload: { url: 'https://s3/put', destination_url: 'https://s3/dest' } })
      .mockResolvedValueOnce({ result: 'success' }); // uploadComplete
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG, confirm: true });
    // step 1: checkin/add with is_photo=true
    expect(write).toHaveBeenNthCalledWith(1, 'POST', '/checkin/add', expect.objectContaining({ form: expect.objectContaining({ is_photo: 'true', photo_file_ext: 'jpg' }) }));
    // step 2: presigned S3 PUT with the JPEG content type
    expect(putBinary).toHaveBeenCalledWith('https://s3/put', expect.anything(), 'image/jpeg');
    // step 3: uploadComplete with checkin_id + destination_url
    expect(write).toHaveBeenNthCalledWith(2, 'POST', '/photo/uploadComplete', { form: { checkin_id: 777, destination_url: 'https://s3/dest' } });
    expect(parse(r as never).photo_attached).toBe(true);
  });

  it('checkin surfaces photo_error (not silent) when no upload URL is returned', async () => {
    write.mockResolvedValueOnce({ checkin_id: 888 }); // no photo_upload in response
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG, confirm: true });
    const out = parse(r as never);
    expect(out.photo_attached).toBe(false);
    expect(typeof out.photo_error).toBe('string');
    expect(putBinary).not.toHaveBeenCalled();
  });

  it('checkin surfaces photo_error when the S3 upload throws (check-in already created)', async () => {
    write.mockResolvedValueOnce({ checkin_id: 999, photo_upload: { url: 'https://s3/put', destination_url: 'https://s3/dest' } });
    putBinary.mockRejectedValueOnce(new Error('S3 fail'));
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG, confirm: true });
    const out = parse(r as never);
    expect(out.checked_in).toBe(true);
    expect(out.photo_attached).toBe(false);
    expect(String(out.photo_error)).toContain('999');
    // uploadComplete must NOT be called after the upload failed (only checkin/add ran)
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('delete_checkin without confirm is a dry run', async () => {
    const r = await harness.callTool('untappd_delete_checkin', { checkin_id: 555 });
    expect(parse(r as never).dryRun).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('delete_checkin with confirm posts to /checkin/delete', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await harness.callTool('untappd_delete_checkin', { checkin_id: 555, confirm: true });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/delete/555');
    expect(parse(r as never).deleted).toBe(true);
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
