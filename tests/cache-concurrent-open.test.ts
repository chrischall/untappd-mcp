import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { retryBusy } from '../src/cache/db.js';

// Several PROCESSES opening one brand-new cache file at the same moment, which is
// what two MCP hosts starting together do (issue #256). The race is between
// processes (SQLite file locks), so threads or a single process can't stand in
// for it: each child imports the BUILT dist/cache/db.js.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_JS = join(ROOT, 'dist', 'cache', 'db.js');

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

beforeAll(() => {
  if (!existsSync(DB_JS) || statSync(DB_JS).mtimeMs < newestMtime(join(ROOT, 'src'))) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 180_000);

// Each child spins until a shared start time (so the opens really collide), opens
// the cache, writes its own sync-state row, and reports how it went.
const CHILD = `
const [dbJs, path, startAt, name] = process.argv.slice(1);
const { CheckinCache } = await import(dbJs);
while (Date.now() < Number(startAt)) {}
try {
  const cache = CheckinCache.open(path);
  await cache.setState(name, { beers_offset: 1 });
  const mode = cache.journalMode();
  cache.close();
  console.log('OK ' + mode);
} catch (e) {
  console.log('FAIL ' + (e && e.message));
  process.exit(1);
}
`;

function runChild(path: string, startAt: number, name: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--no-warnings', '--input-type=module', '-e', CHILD, pathToFileURL(DB_JS).href, path, String(startAt), name]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', () => resolve(out.trim()));
  });
}

describe('CheckinCache.open across processes at once (#256)', () => {
  it('several processes opening one NEW file together all succeed, in WAL, with every write kept', async () => {
    const ROUNDS = 4;
    const PROCS = 8;
    for (let round = 0; round < ROUNDS; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'untappd-open-race-'));
      const path = join(dir, 'checkins.db');
      try {
        const startAt = Date.now() + 600; // after every child has booted
        const names = Array.from({ length: PROCS }, (_, i) => `user${i}`);
        const outs = await Promise.all(names.map((n) => runChild(path, startAt, n)));
        expect(outs).toEqual(names.map(() => 'OK wal'));

        const db = new DatabaseSync(path);
        expect(db.prepare('SELECT COUNT(*) AS n FROM sync_state').get()).toEqual({ n: PROCS });
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

describe('retryBusy', () => {
  const busy = () => Object.assign(new Error('database is locked'), { errcode: 5 });

  it('retries a handler-less SQLITE_BUSY (and its extended codes) until it succeeds', () => {
    let calls = 0;
    const out = retryBusy(() => {
      calls++;
      if (calls === 1) throw busy();
      if (calls === 2) throw Object.assign(new Error('recovery'), { errcode: 261 }); // SQLITE_BUSY_RECOVERY
      return 'done';
    });
    expect(out).toBe('done');
    expect(calls).toBe(3);
  });

  it('throws any other error at once', () => {
    let calls = 0;
    const err = Object.assign(new Error('no such table'), { errcode: 1 });
    expect(() =>
      retryBusy(() => {
        calls++;
        throw err;
      }),
    ).toThrow(err);
    expect(calls).toBe(1);
  });

  it('gives up with the BUSY error once the deadline passes', () => {
    const started = Date.now();
    expect(() =>
      retryBusy(() => {
        throw busy();
      }, 50),
    ).toThrow(/database is locked/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
