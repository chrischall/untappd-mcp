import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { UnreachableError } from '@chrischall/mcp-utils';
import { createBlobStore, mintUploadSlot } from '@chrischall/mcp-utils/export';
import { UntappdClient } from '../../src/client.js';
import { registerCheckinTools } from '../../src/tools/checkin.js';
import { createTestHarness } from '../helpers.js';

// The photo routes a hosted deployment can use: inline base64 and an upload
// slot read back from mcp-host's blob store. The store is real
// (createBlobStore) behind a stubbed fetch whose objects live in a map.

const client = new UntappdClient({ loginName: 'me' });
const write = vi.spyOn(client, 'write');
const putBinary = vi.spyOn(client, 'putBinary').mockResolvedValue(undefined);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const REG = 'reg_0123456789abcdef01234567';
const BASE = `https://blobs.example/b/${REG}`;
const SIGNING_KEY = 'a2V5';

const ADD_OK = { checkin_id: 777, photo_upload: { url: 'https://s3.example/put', destination_url: 'https://s3.example/dest' } };

/** A blob store whose objects live in a map, behind a stubbed fetch; the env points the server at it. */
function fakeStore(opts: { deleteStatus?: number } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const calls: { method: string; key: string }[] = [];
  vi.stubEnv('MCP_BLOB_BASE_URL', BASE);
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', SIGNING_KEY);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.replace(`/b/${REG}/`, ''));
      const method = init?.method ?? 'GET';
      calls.push({ method, key });
      if (method === 'DELETE') {
        if (opts.deleteStatus && opts.deleteStatus >= 400) return new Response('', { status: opts.deleteStatus });
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const o = objects.get(key);
      return o ? new Response(o.bytes.slice(), { headers: { 'content-type': o.type } }) : new Response('', { status: 404 });
    }),
  );
  const store = createBlobStore({ baseUrl: BASE, signingKey: SIGNING_KEY });
  /** What the caller's curl to a slot leaves behind. */
  const upload = (name: string, bytes: Uint8Array) => {
    const slot = mintUploadSlot(store, { filename: name });
    objects.set(slot.blobKey, { bytes, type: slot.mimeType });
    return slot.blobKey;
  };
  const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.key);
  return { objects, calls, upload, deletes };
}

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}
function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeAll(async () => {
  harness = await createTestHarness((server) => registerCheckinTools(server, client));
});
afterAll(() => harness.close());
beforeEach(() => {
  write.mockReset();
  write.mockResolvedValue(undefined as never);
  putBinary.mockClear();
  // A clean local install unless a test says otherwise.
  vi.stubEnv('MCP_DATA_DIR', '');
  vi.stubEnv('MCP_BLOB_BASE_URL', '');
  vi.stubEnv('MCP_BLOB_SIGNING_KEY', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Phase 1 (a preview that writes nothing), then phase 2 with its token. */
async function confirmed(args: Record<string, unknown>) {
  const p1 = parse(await harness.callTool('untappd_checkin', args));
  expect(p1.status).toBe('confirmation-required');
  expect(write).not.toHaveBeenCalled();
  expect(putBinary).not.toHaveBeenCalled();
  return { p1, r: await harness.callTool('untappd_checkin', { ...args, confirmToken: p1.confirmToken }) };
}

describe('untappd_checkin photo: exactly one source', () => {
  it('refuses two photo sources at once, naming the parameters, and posts nothing', async () => {
    const r = await harness.callTool('untappd_checkin', {
      bid: 100,
      photo_path: '/nowhere/pint.jpg',
      photo_inline: { filename: 'pint.jpg', contentBase64: b64(JPEG) },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/exactly one of photo_path, photo_inline or photo_blob_key/);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('untappd_checkin photo_inline', () => {
  it('previews the decoded photo (name, type, size, sha256) and attaches exactly those bytes', async () => {
    write.mockResolvedValueOnce(ADD_OK as never).mockResolvedValueOnce({} as never);
    const { p1, r } = await confirmed({ bid: 100, photo_inline: { filename: 'pint.jpg', contentBase64: b64(JPEG) } });
    const preview = p1.preview as Record<string, unknown>;
    expect(preview.photo).toMatchObject({
      origin: 'inline',
      file_name: 'pint.jpg',
      content_type: 'image/jpeg',
      size_bytes: JPEG.length,
      sha256: sha(JPEG),
    });
    expect((preview.form as Record<string, unknown>).photo_file_ext).toBe('jpg');
    expect(write).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/checkin/add',
      expect.objectContaining({ form: expect.objectContaining({ is_photo: 'true', photo_file_ext: 'jpg' }) }),
    );
    expect(putBinary).toHaveBeenCalledWith('https://s3.example/put', expect.any(Blob), 'image/jpeg');
    const sent = putBinary.mock.calls[0][1] as Blob;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(JPEG);
    const out = parse(r);
    expect(out.photo_attached).toBe(true);
    expect(out).not.toHaveProperty('photo_blob');
  });

  it('sends a PNG as png', async () => {
    const p1 = parse(await harness.callTool('untappd_checkin', { bid: 100, photo_inline: { filename: 'pint.png', contentBase64: b64(PNG) } }));
    expect(((p1.preview as Record<string, unknown>).form as Record<string, unknown>).photo_file_ext).toBe('png');
  });

  it('refuses bad base64 and posts nothing', async () => {
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_inline: { filename: 'pint.jpg', contentBase64: 'not base64!' } });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/not valid base64/);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a non-image type and bytes that are not the claimed image', async () => {
    const pdf = await harness.callTool('untappd_checkin', { bid: 100, photo_inline: { filename: 'menu.pdf', contentBase64: b64(PDF) } });
    expect(isError(pdf)).toBe(true);
    expect(text(pdf)).toMatch(/application\/pdf is not accepted/);
    const fake = await harness.callTool('untappd_checkin', { bid: 100, photo_inline: { filename: 'pint.jpg', contentBase64: b64(PDF) } });
    expect(isError(fake)).toBe(true);
    expect(text(fake)).toMatch(/do not look like image\/jpeg/);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a photo over the 15 MB cap', async () => {
    const big = new Uint8Array(15 * 1024 * 1024 + 3);
    big.set(JPEG);
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_inline: { filename: 'pint.jpg', contentBase64: b64(big) } });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/too large/);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('untappd_upload_slots', () => {
  it('mints a signed PUT slot per photo', async () => {
    fakeStore();
    const r = await harness.callTool('untappd_upload_slots', { slots: [{ filename: 'pint 1.jpg' }, { filename: 'can.png' }] });
    expect(isError(r)).toBe(false);
    const out = parse(r);
    const slots = out.slots as Record<string, unknown>[];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ filename: 'pint 1.jpg', mimeType: 'image/jpeg', method: 'PUT' });
    expect(String(slots[0].blobKey)).toMatch(/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/);
    expect(String(slots[0].uploadUrl).startsWith(BASE)).toBe(true);
    expect(String(slots[0].curl)).toContain("Content-Type: image/jpeg");
    expect(slots[1]).toMatchObject({ filename: 'can.png', mimeType: 'image/png' });
    expect(String(out.next)).toMatch(/photo_blob_key/);
  });

  it('refuses a non-image slot before minting it', async () => {
    fakeStore();
    const r = await harness.callTool('untappd_upload_slots', { slots: [{ filename: 'menu.pdf' }] });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/JPEG or PNG/);
  });

  it('refuses clearly when the deployment has no blob store', async () => {
    const r = await harness.callTool('untappd_upload_slots', { slots: [{ filename: 'pint.jpg' }] });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/no blob store/i);
    expect(text(r)).toMatch(/photo_path|photo_inline/);
  });

  it('is a read-only tool', async () => {
    const { tools } = await harness.client.listTools();
    const t = tools.find((x) => x.name === 'untappd_upload_slots');
    expect(t?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('untappd_checkin photo_blob_key', () => {
  it('attaches the uploaded photo, then deletes the blob and reports it', async () => {
    const store = fakeStore();
    const key = store.upload('pint.jpg', JPEG);
    write.mockResolvedValueOnce(ADD_OK as never).mockResolvedValueOnce({} as never);
    const { p1, r } = await confirmed({ bid: 100, photo_blob_key: key });
    expect((p1.preview as Record<string, unknown>).photo).toMatchObject({
      origin: 'blob',
      file_name: 'pint.jpg',
      content_type: 'image/jpeg',
      size_bytes: JPEG.length,
      sha256: sha(JPEG),
    });
    // Phase 1 only reads the blob.
    const sent = putBinary.mock.calls[0][1] as Blob;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(JPEG);
    expect(write).toHaveBeenNthCalledWith(2, 'POST', '/photo/uploadComplete', {
      form: { checkin_id: 777, destination_url: 'https://s3.example/dest' },
    });
    const out = parse(r);
    expect(out.photo_attached).toBe(true);
    expect(out.photo_blob).toEqual({ deleted: true });
    expect(store.deletes()).toEqual([key]);
    expect(store.objects.has(key)).toBe(false);
  });

  it('keeps the blob when the photo upload fails after the check-in was created', async () => {
    const store = fakeStore();
    const key = store.upload('pint.jpg', JPEG);
    write.mockResolvedValueOnce(ADD_OK as never);
    putBinary.mockRejectedValueOnce(new Error('S3 said no'));
    const { r } = await confirmed({ bid: 100, photo_blob_key: key });
    const out = parse(r);
    expect(out.photo_attached).toBe(false);
    expect(String(out.photo_error)).toContain('777');
    expect(out.photo_blob).toMatchObject({ deleted: false, kept: true, blob_key: key });
    expect(store.deletes()).toEqual([]);
    expect(store.objects.has(key)).toBe(true);
  });

  it('keeps the blob when the check-in itself fails', async () => {
    const store = fakeStore();
    const key = store.upload('pint.jpg', JPEG);
    write.mockRejectedValueOnce(new Error('Untappd refused the check-in'));
    const { r } = await confirmed({ bid: 100, photo_blob_key: key });
    expect(isError(r)).toBe(true);
    expect(store.deletes()).toEqual([]);
    expect(store.objects.has(key)).toBe(true);
  });

  it('keeps the blob when Untappd returns no photo upload URL', async () => {
    const store = fakeStore();
    const key = store.upload('pint.jpg', JPEG);
    write.mockResolvedValueOnce({ checkin_id: 888 } as never);
    const { r } = await confirmed({ bid: 100, photo_blob_key: key });
    const out = parse(r);
    expect(out.photo_attached).toBe(false);
    expect(out.photo_blob).toMatchObject({ deleted: false, kept: true });
    expect(store.deletes()).toEqual([]);
  });

  it('keeps the blob when a timed-out check-in is recovered without its photo', async () => {
    const store = fakeStore();
    const key = store.upload('pint.jpg', JPEG);
    const get = vi.spyOn(client, 'get').mockResolvedValueOnce({
      checkins: { items: [{ checkin_id: 4242, created_at: new Date().toUTCString(), beer: { bid: 100 } }] },
    } as never);
    write.mockRejectedValueOnce(new UnreachableError('timed out'));
    try {
      const { r } = await confirmed({ bid: 100, photo_blob_key: key });
      const out = parse(r);
      expect(out).toMatchObject({ checked_in: true, checkin_id: 4242, recovered: true, photo_attached: false });
      expect(typeof out.photo_error).toBe('string');
      expect(out.photo_blob).toMatchObject({ deleted: false, kept: true, blob_key: key });
      expect(store.deletes()).toEqual([]);
    } finally {
      get.mockRestore();
    }
  });

  it('reports (does not throw) a failed delete after a successful check-in', async () => {
    const store = fakeStore({ deleteStatus: 500 });
    const key = store.upload('pint.jpg', JPEG);
    write.mockResolvedValueOnce(ADD_OK as never).mockResolvedValueOnce({} as never);
    const { r } = await confirmed({ bid: 100, photo_blob_key: key });
    expect(isError(r)).toBe(false);
    const out = parse(r);
    expect(out.photo_attached).toBe(true);
    expect(out.photo_blob).toMatchObject({ deleted: false });
    expect(typeof (out.photo_blob as Record<string, unknown>).error).toBe('string');
  });

  it('refuses a blob that changed between the preview and the confirmation (DRAFT_CHANGED), posting nothing', async () => {
    const store = fakeStore();
    const key = store.upload('pint.jpg', JPEG);
    const p1 = parse(await harness.callTool('untappd_checkin', { bid: 100, photo_blob_key: key }));
    const swapped = JPEG.slice();
    swapped[swapped.length - 1] = 0x02; // same size, same type, different bytes
    store.objects.set(key, { bytes: swapped, type: 'image/jpeg' });
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_blob_key: key, confirmToken: p1.confirmToken });
    expect(parse(r).error).toBe('DRAFT_CHANGED');
    expect(write).not.toHaveBeenCalled();
    expect(putBinary).not.toHaveBeenCalled();
    expect(store.deletes()).toEqual([]);
  });

  it('refuses a key that is not an upload slot key', async () => {
    fakeStore();
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_blob_key: 'files/export.zip' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/not an upload key/);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a blob key when there is no blob store', async () => {
    const r = await harness.callTool('untappd_checkin', {
      bid: 100,
      photo_blob_key: 'uploads/00000000-0000-4000-8000-000000000000/cGludC5qcGc',
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/no blob store/);
  });
});

describe('untappd_checkin photo_path on a hosted deployment', () => {
  it('is refused, pointing at the upload slot flow', async () => {
    fakeStore();
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: '/home/someone/pint.jpg' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/remote/);
    expect(text(r)).toMatch(/untappd_upload_slots/);
    expect(text(r)).toMatch(/photo_blob_key/);
    expect(text(r)).not.toContain('/home/someone');
    expect(write).not.toHaveBeenCalled();
  });

  it('is refused on a hosted deployment with no blob store, pointing at photo_inline', async () => {
    vi.stubEnv('MCP_DATA_DIR', '/data');
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: '/home/someone/pint.jpg' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/photo_inline/);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('untappd_checkin with no photo', () => {
  it('is unchanged on a hosted deployment: no blob traffic, no photo fields', async () => {
    const store = fakeStore();
    write.mockResolvedValueOnce({ checkin_id: 555 } as never);
    const { p1, r } = await confirmed({ bid: 100, rating: 4 });
    const preview = p1.preview as Record<string, unknown>;
    expect(preview.photo).toBeUndefined();
    expect((preview.form as Record<string, unknown>).is_photo).toBe('false');
    const out = parse(r);
    expect(out).toMatchObject({ checked_in: true, checkin_id: 555, photo_attached: false });
    expect(out).not.toHaveProperty('photo_blob');
    expect(store.calls).toEqual([]);
    expect(putBinary).not.toHaveBeenCalled();
  });
});
