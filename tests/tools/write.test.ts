import { writeFileSync, rmSync, mkdirSync, truncateSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UnreachableError } from '@chrischall/mcp-utils';
import { UntappdClient } from '../../src/client.js';
import { registerCheckinTools } from '../../src/tools/checkin.js';
import { registerWishlistTools } from '../../src/tools/wishlist.js';
import { createTestHarness } from '../helpers.js';

const client = new UntappdClient({ loginName: 'me' });
const write = vi.spyOn(client, 'write').mockResolvedValue(undefined as never);
const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);
const putBinary = vi.spyOn(client, 'putBinary').mockResolvedValue(undefined);

const TMP_JPG = join(tmpdir(), 'untappd-test-photo.jpg');
writeFileSync(TMP_JPG, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
// Not an image at all, just named like one (e.g. a private document).
const TMP_FAKE_JPG = join(tmpdir(), 'untappd-test-not-a-photo.jpg');
writeFileSync(TMP_FAKE_JPG, 'SECRET=hunter2\n');
// A real PNG signature behind a .jpg name.
const TMP_PNG_AS_JPG = join(tmpdir(), 'untappd-test-png-named.jpg');
writeFileSync(TMP_PNG_AS_JPG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
// A JPEG header on a file bigger than any phone photo.
const TMP_HUGE_JPG = join(tmpdir(), 'untappd-test-huge.jpg');
writeFileSync(TMP_HUGE_JPG, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
truncateSync(TMP_HUGE_JPG, 30 * 1024 * 1024);
const TMP_PHOTO_DIR = join(tmpdir(), 'untappd-test-photo-dir');
mkdirSync(TMP_PHOTO_DIR, { recursive: true });

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  write.mockClear();
  putBinary.mockClear();
  get.mockReset();
});
afterAll(async () => {
  if (harness) await harness.close();
  for (const f of [TMP_JPG, TMP_FAKE_JPG, TMP_PNG_AS_JPG, TMP_HUGE_JPG]) rmSync(f, { force: true });
  rmSync(TMP_PHOTO_DIR, { recursive: true, force: true });
});

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function preview(result: unknown): Record<string, unknown> {
  return parse(result as never).preview as Record<string, unknown>;
}

/** Phase 1 (asserting it is a preview that writes nothing), then phase 2 with its token. */
async function confirmed(tool: string, args: Record<string, unknown>) {
  const p1 = parse((await harness.callTool(tool, args)) as never);
  expect(p1.status).toBe('confirmation-required');
  expect(typeof p1.confirmToken).toBe('string');
  expect(write).not.toHaveBeenCalled();
  expect(putBinary).not.toHaveBeenCalled();
  return harness.callTool(tool, { ...args, confirmToken: p1.confirmToken });
}

describe('write tools (confirm-token gated)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerCheckinTools(server, client);
      registerWishlistTools(server, client);
    });
  });

  it('toast phase 1 is a preview and makes NO network call', async () => {
    const r = await harness.callTool('untappd_toast', { checkin_id: 42 });
    expect(parse(r as never).status).toBe('confirmation-required');
    expect(write).not.toHaveBeenCalled();
  });

  it('toast with the confirmToken posts to the toast endpoint', async () => {
    write.mockResolvedValueOnce({ result: 'success', like_type: 'toast' });
    const r = await confirmed('untappd_toast', { checkin_id: 42 });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/toast/42');
    expect(parse(r as never).toggled).toBe(true);
  });

  it('add_comment phase 1 is a preview (no network call)', async () => {
    const r = await harness.callTool('untappd_add_comment', { checkin_id: 42, comment: 'nice' });
    expect(parse(r as never).status).toBe('confirmation-required');
    expect(write).not.toHaveBeenCalled();
  });

  it('add_comment with the confirmToken posts the comment form', async () => {
    write.mockResolvedValueOnce({});
    await confirmed('untappd_add_comment', { checkin_id: 42, comment: 'nice' });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/addcomment/42', { form: { comment: 'nice' } });
  });

  it('delete_comment phase 1 is a preview (no network call)', async () => {
    const r = await harness.callTool('untappd_delete_comment', { comment_id: 89011936 });
    expect(parse(r as never).status).toBe('confirmation-required');
    expect(write).not.toHaveBeenCalled();
  });

  it('delete_comment with the confirmToken posts to deletecomment', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await confirmed('untappd_delete_comment', { comment_id: 89011936 });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/deletecomment/89011936');
    expect(parse(r as never).deleted).toBe(true);
  });

  it('checkin phase 1 previews the exact form and makes NO network call', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, rating: 4.25, shout: 'great' });
    const out = parse(r as never);
    expect(out.status).toBe('confirmation-required');
    const form = (out.preview as Record<string, unknown>).form as Record<string, unknown>;
    expect(form.bid).toBe(100);
    expect(form.rating).toBe('4.25');
    expect(form.shout).toBe('great');
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin with the confirmToken posts to /checkin/add with a formatted rating', async () => {
    write.mockResolvedValueOnce({ checkin_id: 555 });
    const r = await confirmed('untappd_checkin', { bid: 100, rating: 4 });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/add', expect.objectContaining({ form: expect.objectContaining({ bid: 100, rating: '4.00' }) }));
    expect(parse(r as never).checked_in).toBe(true);
  });

  it('checkin sends the caller-supplied IANA timezone and its current GMT offset', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, timezone: 'Asia/Kolkata' });
    const form = preview(r).form as Record<string, unknown>;
    expect(form.timezone).toBe('Asia/Kolkata');
    expect(form.gmt_offset).toBe(5.5); // no DST, so stable year-round
  });

  it('checkin rejects a timezone that is not a valid IANA name', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, timezone: 'Mars/Olympus' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin falls back to UNTAPPD_TIMEZONE (not the host process zone) when no timezone is given', async () => {
    process.env.UNTAPPD_TIMEZONE = 'Asia/Kathmandu';
    try {
      const r = await harness.callTool('untappd_checkin', { bid: 100 });
      const form = preview(r).form as Record<string, unknown>;
      expect(form.timezone).toBe('Asia/Kathmandu');
      expect(form.gmt_offset).toBe(5.75);
    } finally {
      delete process.env.UNTAPPD_TIMEZONE;
    }
  });

  it('checkin rejects a rating that is not a 0.25 multiple', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, rating: 4.1 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin with a photo previews the photo in phase 1 (no upload)', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
    const out = parse(r as never);
    expect(out.status).toBe('confirmation-required');
    expect((preview(r).form as Record<string, unknown>).is_photo).toBe('true');
    expect((preview(r).form as Record<string, unknown>).photo_file_ext).toBe('jpg');
    expect(write).not.toHaveBeenCalled();
    expect(putBinary).not.toHaveBeenCalled();
  });

  it('checkin preview shows the resolved absolute path and size of the photo it would publish', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
    const photo = preview(r).photo as Record<string, unknown>;
    expect(photo.path).toBe(realpathSync(TMP_JPG));
    expect(photo.size_bytes).toBe(5);
    expect(photo.content_type).toBe('image/jpeg');
  });

  it('checkin refuses a .jpg-named file whose bytes are not an image (no upload, no check-in)', async () => {
    for (const confirmToken of [undefined, 'utc1.forged']) {
      const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_FAKE_JPG, confirmToken });
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain('hunter2');
    }
    expect(write).not.toHaveBeenCalled();
    expect(putBinary).not.toHaveBeenCalled();
  });

  it('checkin refuses a photo whose content does not match its extension', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_PNG_AS_JPG });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin refuses an oversized photo before creating the check-in', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_HUGE_JPG });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin confines photo_path to UNTAPPD_PHOTO_DIR when it is set', async () => {
    process.env.UNTAPPD_PHOTO_DIR = TMP_PHOTO_DIR;
    try {
      const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(write).not.toHaveBeenCalled();
      const inside = join(TMP_PHOTO_DIR, 'pint.jpg');
      writeFileSync(inside, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
      const ok = await harness.callTool('untappd_checkin', { bid: 100, photo_path: inside });
      expect(parse(ok as never).status).toBe('confirmation-required');
    } finally {
      delete process.env.UNTAPPD_PHOTO_DIR;
    }
  });

  it('checkin reports a missing photo without echoing the path', async () => {
    const missing = join(tmpdir(), 'untappd-no-such-dir', 'x.jpg');
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: missing });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain('untappd-no-such-dir');
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin rejects an unsupported photo type', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: '/tmp/nope.gif' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('checkin with a photo runs the 3-step upload flow', async () => {
    write
      .mockResolvedValueOnce({ checkin_id: 777, photo_upload: { url: 'https://s3/put', destination_url: 'https://s3/dest' } })
      .mockResolvedValueOnce({ result: 'success' }); // uploadComplete
    const r = await confirmed('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
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
    const r = await confirmed('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
    const out = parse(r as never);
    expect(out.photo_attached).toBe(false);
    expect(typeof out.photo_error).toBe('string');
    expect(putBinary).not.toHaveBeenCalled();
  });

  it('checkin surfaces photo_error when the S3 upload throws (check-in already created)', async () => {
    write.mockResolvedValueOnce({ checkin_id: 999, photo_upload: { url: 'https://s3/put', destination_url: 'https://s3/dest' } });
    putBinary.mockRejectedValueOnce(new Error('S3 fail'));
    const r = await confirmed('untappd_checkin', { bid: 100, photo_path: TMP_JPG });
    const out = parse(r as never);
    expect(out.checked_in).toBe(true);
    expect(out.photo_attached).toBe(false);
    expect(String(out.photo_error)).toContain('999');
    // uploadComplete must NOT be called after the upload failed (only checkin/add ran)
    expect(write).toHaveBeenCalledTimes(1);
  });

  // A transport failure/timeout AFTER the POST was sent leaves the outcome unknown:
  // Untappd may already have created it. A blind retry would double-post.
  const recentCheckin = (id: number, bid: number, at: Date) => ({
    checkin_id: id,
    created_at: at.toUTCString().replace('GMT', '+0000'),
    beer: { bid },
  });

  it('checkin that times out reports the check-in Untappd did create instead of failing', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    get.mockResolvedValueOnce({ checkins: { items: [recentCheckin(4242, 100, new Date()), recentCheckin(4000, 7, new Date())] } });
    const r = await confirmed('untappd_checkin', { bid: 100 });
    const out = parse(r as never);
    expect(get).toHaveBeenCalledWith('/user/checkins/me', { limit: 5 });
    expect(out.checked_in).toBe(true);
    expect(out.checkin_id).toBe(4242);
    expect(out.recovered).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('checkin that times out and left no check-in says the outcome is unknown and not to blindly retry', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    // Only an OLD check-in of the same beer — not one this call made.
    get.mockResolvedValueOnce({ checkins: { items: [recentCheckin(1, 100, new Date(Date.now() - 3 * 3600_000))] } });
    const r = await confirmed('untappd_checkin', { bid: 100 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toMatch(/may have been created/i);
    expect(text).toContain('untappd_user_checkins');
  });

  it('checkin that times out does not claim an earlier same-beer check-in (e.g. a prior timed-out attempt) as its own', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    // Same beer, two minutes before this POST — a previous attempt, not this one.
    get.mockResolvedValueOnce({ checkins: { items: [recentCheckin(3000, 100, new Date(Date.now() - 2 * 60_000))] } });
    const r = await confirmed('untappd_checkin', { bid: 100 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toMatch(/may have been created/i);
    expect(text).not.toContain('Do not retry');
  });

  it('checkin that times out reports outcome unknown when more than one same-beer check-in matches', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    const now = new Date();
    get.mockResolvedValueOnce({ checkins: { items: [recentCheckin(5001, 100, now), recentCheckin(5000, 100, now)] } });
    const r = await confirmed('untappd_checkin', { bid: 100 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toMatch(/may have been created/i);
    expect(text).not.toContain('Do not retry');
  });

  it('checkin that times out and cannot verify still warns instead of inviting a duplicate', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    get.mockRejectedValueOnce(new UnreachableError('Untappd'));
    const r = await confirmed('untappd_checkin', { bid: 100 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/may have been created/i);
  });

  it('checkin passes through ordinary (definite) API errors unchanged, with no recovery lookup', async () => {
    write.mockRejectedValueOnce(new Error('Untappd POST /checkin/add failed (500): boom'));
    const r = await confirmed('untappd_checkin', { bid: 100 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('add_comment that times out says the comment may have posted and how to check', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    const r = await confirmed('untappd_add_comment', { checkin_id: 42, comment: 'nice' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toMatch(/may have been posted/i);
    expect(text).toContain('untappd_checkin_info');
  });

  it('toast that times out warns that a retry could UN-toast', async () => {
    write.mockRejectedValueOnce(new UnreachableError('Untappd'));
    const r = await confirmed('untappd_toast', { checkin_id: 42 });
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toMatch(/toggle/i);
    expect(text).toContain('untappd_checkin_info');
  });

  it('delete_checkin phase 1 is a preview (no network call)', async () => {
    const r = await harness.callTool('untappd_delete_checkin', { checkin_id: 555 });
    expect(parse(r as never).status).toBe('confirmation-required');
    expect(write).not.toHaveBeenCalled();
  });

  it('delete_checkin with the confirmToken posts to /checkin/delete', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await confirmed('untappd_delete_checkin', { checkin_id: 555 });
    expect(write).toHaveBeenCalledWith('POST', '/checkin/delete/555');
    expect(parse(r as never).deleted).toBe(true);
  });

  it('wishlist_add phase 1 is a preview (no network call)', async () => {
    const r = await harness.callTool('untappd_wishlist_add', { bid: 3839 });
    expect(parse(r as never).status).toBe('confirmation-required');
    expect(write).not.toHaveBeenCalled();
  });

  it('wishlist_add with the confirmToken hits /user/wishlist/add', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await confirmed('untappd_wishlist_add', { bid: 3839 });
    expect(write).toHaveBeenCalledWith('GET', '/user/wishlist/add', { query: { bid: 3839 } });
    expect(parse(r as never).added).toBe(true);
  });

  it('wishlist_remove phase 1 is a preview (no network call)', async () => {
    const r = await harness.callTool('untappd_wishlist_remove', { bid: 3839 });
    expect(parse(r as never).status).toBe('confirmation-required');
    expect(write).not.toHaveBeenCalled();
  });

  it('wishlist_remove with the confirmToken hits /user/wishlist/delete', async () => {
    write.mockResolvedValueOnce({ result: 'success' });
    const r = await confirmed('untappd_wishlist_remove', { bid: 3839 });
    expect(write).toHaveBeenCalledWith('GET', '/user/wishlist/delete', { query: { bid: 3839 } });
    expect(parse(r as never).removed).toBe(true);
  });
  it('every write previews the exact request it will send (method, path, fields)', async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['untappd_toast', { checkin_id: 42 }, { action: 'toast', checkin_id: 42, method: 'POST', path: '/checkin/toast/42' }],
      ['untappd_add_comment', { checkin_id: 42, comment: 'nice' }, { action: 'add_comment', checkin_id: 42, comment: 'nice', method: 'POST', path: '/checkin/addcomment/42', form: { comment: 'nice' } }],
      ['untappd_delete_comment', { comment_id: 7 }, { action: 'delete_comment', comment_id: 7, method: 'POST', path: '/checkin/deletecomment/7' }],
      ['untappd_delete_checkin', { checkin_id: 555 }, { action: 'delete_checkin', checkin_id: 555, method: 'POST', path: '/checkin/delete/555' }],
      ['untappd_wishlist_add', { bid: 3839 }, { action: 'wishlist_add', bid: 3839, method: 'GET', path: '/user/wishlist/add', query: { bid: 3839 } }],
      ['untappd_wishlist_remove', { bid: 3839 }, { action: 'wishlist_remove', bid: 3839, method: 'GET', path: '/user/wishlist/delete', query: { bid: 3839 } }],
    ];
    for (const [tool, args, expected] of cases) {
      const out = parse((await harness.callTool(tool, args)) as never);
      expect(out.status).toBe('confirmation-required');
      expect(out.preview).toMatchObject(expected);
      expect(typeof (out.preview as Record<string, unknown>).note).toBe('string');
    }
    const checkin = preview(await harness.callTool('untappd_checkin', { bid: 100, photo_path: TMP_JPG }));
    expect(checkin).toMatchObject({ action: 'checkin', method: 'POST', path: '/checkin/add' });
    expect((checkin.photo as Record<string, unknown>).note).toMatch(/PUBLICLY/);
    expect(write).not.toHaveBeenCalled();
  });

  it('a used token cannot be replayed (TOKEN_REUSED) and writes nothing more', async () => {
    const p1 = parse((await harness.callTool('untappd_toast', { checkin_id: 42 })) as never);
    write.mockResolvedValue({ result: 'success' });
    await harness.callTool('untappd_toast', { checkin_id: 42, confirmToken: p1.confirmToken });
    expect(write).toHaveBeenCalledTimes(1);
    const replay = await harness.callTool('untappd_toast', { checkin_id: 42, confirmToken: p1.confirmToken });
    expect((replay as { isError?: boolean }).isError).toBe(true);
    expect(parse(replay as never).error).toBe('TOKEN_REUSED');
    expect(write).toHaveBeenCalledTimes(1);
    write.mockResolvedValue(undefined as never);
  });

  it('changing an argument between the phases is refused (DRAFT_CHANGED) and writes nothing', async () => {
    const p1 = parse((await harness.callTool('untappd_add_comment', { checkin_id: 42, comment: 'nice' })) as never);
    const r = await harness.callTool('untappd_add_comment', { checkin_id: 42, comment: 'rude', confirmToken: p1.confirmToken });
    expect((r as { isError?: boolean }).isError).toBe(true);
    const out = parse(r as never);
    expect(out.error).toBe('DRAFT_CHANGED');
    expect((out.preview as Record<string, unknown>).comment).toBe('rude');
    expect(write).not.toHaveBeenCalled();
  });

  it('a photo file that changes between the phases is refused (DRAFT_CHANGED) and nothing is posted', async () => {
    const photo = join(tmpdir(), 'untappd-test-swapped.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    try {
      const p1 = parse((await harness.callTool('untappd_checkin', { bid: 100, photo_path: photo })) as never);
      writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02]));
      const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: photo, confirmToken: p1.confirmToken });
      expect(parse(r as never).error).toBe('DRAFT_CHANGED');
      expect(write).not.toHaveBeenCalled();
      expect(putBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(photo, { force: true });
    }
  });

  it('a same-size photo swapped in between the phases is refused (DRAFT_CHANGED) and nothing is posted', async () => {
    const photo = join(tmpdir(), 'untappd-test-same-size-swap.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]));
    try {
      const p1 = parse((await harness.callTool('untappd_checkin', { bid: 100, photo_path: photo })) as never);
      // Same path, same size, same type — only the bytes differ.
      writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]));
      const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: photo, confirmToken: p1.confirmToken });
      expect(parse(r as never).error).toBe('DRAFT_CHANGED');
      expect(write).not.toHaveBeenCalled();
      expect(putBinary).not.toHaveBeenCalled();
    } finally {
      rmSync(photo, { force: true });
    }
  });

  it('MCP_CONFIRM_MODE=refuse refuses on a client that cannot be prompted, with no write', async () => {
    const saved = process.env.MCP_CONFIRM_MODE;
    process.env.MCP_CONFIRM_MODE = 'refuse';
    try {
      const r = await harness.callTool('untappd_wishlist_add', { bid: 3839 });
      const out = parse(r as never);
      expect(out.reason).toBe('confirmation-unsupported');
      expect(out.confirmToken).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.MCP_CONFIRM_MODE;
      else process.env.MCP_CONFIRM_MODE = saved;
    }
  });
});

describe('write tools on a client that can show a confirmation prompt', () => {
  const register = (server: Parameters<Parameters<typeof createTestHarness>[0]>[0]) => {
    registerCheckinTools(server, client);
    registerWishlistTools(server, client);
  };

  it('writes once the user accepts the prompt', async () => {
    const prompts: unknown[] = [];
    const h = await createTestHarness(register, {
      elicitation: async (req) => {
        prompts.push(req);
        return { action: 'accept', content: { confirmed: true } };
      },
    });
    try {
      write.mockResolvedValueOnce({ result: 'success' });
      const r = await h.callTool('untappd_delete_checkin', { checkin_id: 555 });
      expect(prompts).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('POST', '/checkin/delete/555');
      expect(parse(r as never).deleted).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('writes nothing when the user declines the prompt', async () => {
    const h = await createTestHarness(register, { elicitation: async () => ({ action: 'decline' }) });
    try {
      const r = await h.callTool('untappd_delete_checkin', { checkin_id: 555 });
      expect(parse(r as never).confirmed).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
