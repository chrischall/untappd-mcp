import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// Cross-PROCESS persistence tests. Each spawns the real built server
// (dist/bundle.js — what the .mcpb runs) with fetch replaced by a fake Untappd
// API (tests/fixtures/mock-untappd-fetch.mjs), so the cache really goes to
// disk, the process really dies, and a NEW process has to find it again.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const PRELOAD = join(ROOT, 'tests', 'fixtures', 'mock-untappd-fetch.mjs');

/** Newest mtime under a directory (to tell whether dist/ is older than src/). */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

beforeAll(() => {
  // These tests exercise tools added alongside them, so a stale bundle is as
  // bad as a missing one.
  if (!existsSync(BUNDLE) || statSync(BUNDLE).mtimeMs < newestMtime(join(ROOT, 'src'))) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 180_000);

interface Server {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  stderr(): string;
  kill(): Promise<void>;
}

const live: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL');
});

/** Spawn the bundled server under the fetch mock and speak JSON-RPC to it over stdio. */
function startServer(opts: { cwd: string; env: Record<string, string> }): Server {
  const child = spawn('node', ['--no-warnings', '--import', PRELOAD, BUNDLE], {
    cwd: opts.cwd,
    env: {
      PATH: process.env.PATH ?? '',
      // A pre-seeded token: no xauth login, so the mock only ever sees API reads.
      UNTAPPD_ACCESS_TOKEN: 'test-token',
      UNTAPPD_USERNAME: '',
      UNTAPPD_PASSWORD: '',
      MCP_CONFIRM_ELICITATION: 'off',
      ...opts.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.push(child);
  let buf = '';
  let err = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  child.stderr.on('data', (d) => (err += d.toString()));
  const send = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const ready = send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'persistence-test', version: '1' },
  }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));

  return {
    async call(name, args) {
      await ready;
      const res = (await send('tools/call', { name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      if (res.isError) throw new Error(`${name} failed: ${res.content[0]?.text}\nstderr:\n${err}`);
      return JSON.parse(res.content[0].text);
    },
    stderr: () => err,
    // SIGKILL, not a graceful shutdown: the cache must survive a crash, with
    // whatever is still in the WAL.
    kill: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      }),
  };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** API requests a process sent (one URL per line in its mock log). */
function requests(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

describe('cache persistence across processes (built server)', () => {
  it('answers has_had_many from disk in a NEW process with zero API calls and full coverage', async () => {
    const home = tmp('untappd-home-');
    const logA = join(home, 'a.log');
    const logB = join(home, 'b.log');
    const users = JSON.stringify({ mer: 120 });
    try {
      // Process A: launched from one directory, with no cache override — the
      // default ~/.untappd-mcp/checkins.db under this HOME.
      const a = startServer({ cwd: tmp('cwd-a-'), env: { HOME: home, MOCK_USERS: users, MOCK_LOG: logA } });
      const sync = await a.call('untappd_sync_user_beers', { username: 'mer', max_pages: 50 });
      expect(sync).toMatchObject({ beers_complete: true, cached_distinct_beers: 120, another_run_needed: false });
      expect(requests(logA)).toHaveLength(3);
      const expectedPath = join(home, '.untappd-mcp', 'checkins.db');
      expect(a.stderr()).toContain(`[untappd-mcp] cache: ${expectedPath}`);
      await a.kill();

      // Process B: different working directory, same HOME.
      const b = startServer({ cwd: tmp('cwd-b-'), env: { HOME: home, MOCK_USERS: users, MOCK_LOG: logB } });
      const had = await b.call('untappd_cache_has_had_many', { username: 'mer', bids: [1000, 1119, 999_999] });
      expect(requests(logB)).toEqual([]); // answered from disk alone
      expect(had).toMatchObject({ checked: 3, had: 2, not_had: 1 });
      expect((had.freshness as Record<string, unknown>).coverage_complete).toBe(true);

      const status = await b.call('untappd_cache_status', {});
      expect(status).toMatchObject({
        cache_path: expectedPath,
        journal_mode: 'wal',
        schema_version: 3,
        users: [{ username: 'mer', cached_distinct_beers: 120, total_distinct_beers: 120, coverage_complete: true }],
      });
      expect(status.file_size_bytes).toBeGreaterThan(0);
      expect(requests(logB)).toEqual([]);
      await b.kill();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('resumes an interrupted backfill from the saved offset in a new process', async () => {
    const home = tmp('untappd-home-');
    const cacheDir = join(home, 'custom-cache');
    const logA = join(home, 'a.log');
    const logB = join(home, 'b.log');
    const users = JSON.stringify({ mer: 300 });
    try {
      // Process A is rate-limited after 3 pages (150 beers) mid-backfill.
      const a = startServer({
        cwd: home,
        env: { HOME: home, UNTAPPD_CACHE_DIR: cacheDir, MOCK_USERS: users, MOCK_LOG: logA, MOCK_FAIL_AFTER: '3' },
      });
      await expect(a.call('untappd_sync_user_beers', { username: 'mer', max_pages: 50 })).rejects.toThrow(/Rate limited/);
      await a.kill();

      const b = startServer({ cwd: home, env: { HOME: home, UNTAPPD_CACHE_DIR: cacheDir, MOCK_USERS: users, MOCK_LOG: logB } });
      const before = await b.call('untappd_cache_status', {});
      expect(before.users).toEqual([
        expect.objectContaining({ username: 'mer', cached_distinct_beers: 150, beers_offset: 150, coverage_complete: false }),
      ]);
      const sync = await b.call('untappd_sync_user_beers', { username: 'mer', max_pages: 50 });
      expect(sync).toMatchObject({ beers_complete: true, cached_distinct_beers: 300 });
      // Resumed at the saved offset (less the 10-item RESUME_OVERLAP), not 0.
      const first = new URL(`https://x${requests(logB)[0]}`);
      expect(first.searchParams.get('offset')).toBe('140');
      expect(requests(logB)).toHaveLength(4); // 140, 190, 240, 290
      await b.kill();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('two server processes syncing into one cache at once lose no rows and leave it intact', async () => {
    const home = tmp('untappd-home-');
    const users = JSON.stringify({ alice: 1500, bob: 1500 });
    const env = { HOME: home, MOCK_USERS: users };
    try {
      const p1 = startServer({ cwd: home, env });
      const p2 = startServer({ cwd: home, env });
      // Both processes write BOTH users, in opposite orders, at the same time —
      // overlapping upserts into the same (username, bid) keys plus sync_state.
      const run = async (s: Server, order: string[]) => {
        for (const u of order) await s.call('untappd_sync_user_beers', { username: u, max_pages: 50 });
      };
      await Promise.all([run(p1, ['alice', 'bob']), run(p2, ['bob', 'alice'])]);
      expect(p1.stderr() + p2.stderr()).not.toMatch(/SQLITE_BUSY|database is locked/);
      await Promise.all([p1.kill(), p2.kill()]);

      const p3 = startServer({ cwd: home, env });
      const status = await p3.call('untappd_cache_status', {});
      expect(status.users).toEqual([
        expect.objectContaining({ username: 'alice', cached_distinct_beers: 1500, coverage_complete: true }),
        expect.objectContaining({ username: 'bob', cached_distinct_beers: 1500, coverage_complete: true }),
      ]);
      await p3.kill();

      const db = new DatabaseSync(join(home, '.untappd-mcp', 'checkins.db'));
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM distinct_beers').get()).toEqual({ n: 3000 });
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
