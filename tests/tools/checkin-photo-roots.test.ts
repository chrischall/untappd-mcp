import { writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import * as mcpUtils from '@chrischall/mcp-utils';
import { UntappdClient } from '../../src/client.js';
import { registerCheckinTools } from '../../src/tools/checkin.js';
import { createTestHarness } from '../helpers.js';

// Wrap the real readFileHead so a test can act between checkPhoto's up-front
// UNTAPPD_PHOTO_DIR check and the header read itself (a TOCTOU swap).
const hooks: { beforeHead?: (path: string) => void } = {};
vi.mock('@chrischall/mcp-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils')>();
  return {
    ...actual,
    readFileHead: vi.fn((path: string, ...rest: unknown[]) => {
      hooks.beforeHead?.(path);
      return (actual.readFileHead as (...a: unknown[]) => unknown)(path, ...rest);
    }),
  };
});

const client = new UntappdClient({ loginName: 'me' });
const write = vi.spyOn(client, 'write').mockResolvedValue(undefined as never);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const ROOT = join(tmpdir(), `untappd-photo-roots-${process.pid}`);
const PHOTO_DIR = join(ROOT, 'photos');
const OUTSIDE = join(ROOT, 'outside.jpg');
mkdirSync(PHOTO_DIR, { recursive: true });
writeFileSync(OUTSIDE, JPEG);

const savedPhotoDir = process.env.UNTAPPD_PHOTO_DIR;
afterEach(() => {
  hooks.beforeHead = undefined;
  if (savedPhotoDir === undefined) delete process.env.UNTAPPD_PHOTO_DIR;
  else process.env.UNTAPPD_PHOTO_DIR = savedPhotoDir;
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

describe('checkin photo header read honours UNTAPPD_PHOTO_DIR', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  beforeAll(async () => {
    harness = await createTestHarness((server) => registerCheckinTools(server, client));
  });
  afterAll(() => harness.close());

  it('passes the photo roots to readFileHead', async () => {
    process.env.UNTAPPD_PHOTO_DIR = PHOTO_DIR;
    const inside = join(PHOTO_DIR, 'pint.jpg');
    writeFileSync(inside, JPEG);
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: inside });
    expect(parse(r).status).toBe('confirmation-required');
    expect(vi.mocked(mcpUtils.readFileHead)).toHaveBeenLastCalledWith(
      expect.any(String),
      16,
      expect.objectContaining({ allowedRoots: [PHOTO_DIR] }),
    );
  });

  it('refuses the header read when the photo is swapped for a symlink out of UNTAPPD_PHOTO_DIR after the up-front check', async () => {
    process.env.UNTAPPD_PHOTO_DIR = PHOTO_DIR;
    const inside = join(PHOTO_DIR, 'swapped.jpg');
    writeFileSync(inside, JPEG);
    hooks.beforeHead = (path) => {
      rmSync(path, { force: true });
      symlinkSync(OUTSIDE, path);
    };
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: inside });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(ROOT);
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves the header read unconfined when UNTAPPD_PHOTO_DIR is unset', async () => {
    delete process.env.UNTAPPD_PHOTO_DIR;
    const r = await harness.callTool('untappd_checkin', { bid: 100, photo_path: OUTSIDE });
    expect(parse(r).status).toBe('confirmation-required');
  });
});
