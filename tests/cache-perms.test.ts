import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { CheckinCache } from '../src/cache/db.js';

const mode = (p: string) => statSync(p).mode & 0o777;
const posix = process.platform !== 'win32';

describe('on-disk cache permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'untappd-cache-perm-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.runIf(posix)('creates the cache dir 0700 and the db file 0600', () => {
    const dir = join(root, 'fresh', 'nested');
    const file = join(dir, 'checkins.db');
    const cache = CheckinCache.open(file);
    try {
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(root, 'fresh'))).toBe(0o700);
      expect(mode(file)).toBe(0o600);
    } finally {
      cache.close();
    }
  });

  it.runIf(posix)('tightens a pre-existing world-readable dir and db file', () => {
    const dir = join(root, 'loose');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const file = join(dir, 'checkins.db');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    const cache = CheckinCache.open(file);
    try {
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
    } finally {
      cache.close();
    }
  });
});

