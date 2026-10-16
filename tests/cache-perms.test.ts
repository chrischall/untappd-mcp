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

  it.runIf(posix)('tightens a pre-existing db file but leaves a user-chosen pre-existing dir alone', () => {
    // UNTAPPD_CACHE_DB is a free path: pointing it at ~/Dropbox/untappd.db
    // must not make the whole of ~/Dropbox owner-only.
    const dir = join(root, 'loose');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const file = join(dir, 'checkins.db');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    const cache = CheckinCache.open(file);
    try {
      expect(mode(dir)).toBe(0o755);
      expect(mode(file)).toBe(0o600);
    } finally {
      cache.close();
    }
  });

  it.runIf(posix)('only tightens the dirs it creates under a pre-existing user dir', () => {
    const shared = join(root, 'shared');
    mkdirSync(shared, { recursive: true });
    chmodSync(shared, 0o755);
    const dir = join(shared, 'beer');
    const file = join(dir, 'checkins.db');
    const cache = CheckinCache.open(file);
    try {
      expect(mode(shared)).toBe(0o755);
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
    } finally {
      cache.close();
    }
  });

  it.runIf(posix)('still tightens a loose pre-existing default ~/.untappd-mcp dir (the server owns it)', () => {
    const home = join(root, 'home');
    const dir = join(home, '.untappd-mcp');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const cache = CheckinCache.open(join(dir, 'checkins.db'));
      try {
        expect(mode(dir)).toBe(0o700);
      } finally {
        cache.close();
      }
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

