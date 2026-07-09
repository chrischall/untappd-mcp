# Injected-Client Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the module-level `client` singleton so every tool gets a client injected, and expand `UntappdClient` construction so a per-user client can be built from a pre-obtained token + app credentials (no password) — making the tools reusable by the forthcoming Cloudflare remote-connector worker while keeping the stdio server and all tests green.

**Architecture:** Each `registerXxxTools(server)` becomes `registerXxxTools(server, client)`. `src/index.ts` constructs the env-based client once and threads it into each registrar via a closure (preserving `runMcp`'s `(server) => void` tool contract). `UntappdClient`'s options gain discrete `token` / `clientId` / `clientSecret` / `username` / `password` / `loginName` fields (all optional, each falling back to its env var), so the worker can construct `new UntappdClient({ token, clientId, clientSecret, loginName })` with no password.

**Tech Stack:** TypeScript (NodeNext ESM), `@modelcontextprotocol/sdk` `McpServer`, `@chrischall/mcp-utils`, vitest.

## Global Constraints

- ESM + NodeNext: every relative import ends in `.js`, even from `.ts`.
- Deferred-config-error pattern preserved: constructing a client with missing creds must NOT throw; the error surfaces on the first request needing that credential.
- `zod@^4`, tool handlers return `textResult(...)`; writes stay `confirm`-gated (unchanged here).
- No new runtime dependencies.
- Version is managed by release-please; do NOT hand-edit `src/version.ts` or any version field.
- The stdio server behavior and the public tool roster (37 tools) must be unchanged by this refactor — same tools, same endpoints, same outputs.

---

### Task 1: Expand `UntappdClient` construction (worker-ready options)

Make the client constructible from discrete credential fields and a pre-seeded token, so the write path works with `{ token, clientId, clientSecret }` and no password. Preserve the env-based stdio path and the deferred-config error.

**Files:**
- Modify: `src/client.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface ClientOptions { fetchImpl?: typeof fetch; token?: string; clientId?: string; clientSecret?: string; username?: string; password?: string; loginName?: string; }`
  - `class UntappdClient` — constructor `(opts?: ClientOptions)`; public: `get<T>(path, query?)`, `write<T>(method, path, opts?)`, `putBinary(url, body, contentType)` *(unchanged)*, getters `configured: boolean` and `loginName: string | null`.
  - Behavior: `clientId`/`clientSecret`/`username`/`password` each default to `readEnvVar('UNTAPPD_CLIENT_ID' | ...)`. `loginName` defaults to the resolved `username`. The **write path** (`auth: 'bearer'`) requires only `clientId` + `clientSecret` (+ a token, obtained via login OR pre-seeded). The **login path** (xauth) requires `username` + `password` + `clientId` + `clientSecret`. A pre-seeded `token` skips login entirely, so reads/writes work without a username/password.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client.test.ts` (keep the existing tests; they already pass `credentials` — update those to the new options shape in Step 3's companion edit):

```ts
it('builds a working write-path client from token + app creds, no password', async () => {
  const { impl, calls } = mockFetch([json({ meta: { code: 200 }, response: { result: 'success' } })]);
  const client = new UntappdClient({ fetchImpl: impl, token: 'TOK', clientId: 'CID', clientSecret: 'CSEC', loginName: 'chris' });
  await client.write('POST', '/checkin/toast/42');
  expect(calls).toHaveLength(1);          // NO login call — token was pre-seeded
  expect(calls[0].headers.Authorization).toBe('Bearer TOK');
  expect(calls[0].url).toContain('client_id=CID');
  expect(client.loginName).toBe('chris');
  expect(client.configured).toBe(true);
});

it('a token-seeded read sends the token in the query and never logs in', async () => {
  const { impl, calls } = mockFetch([json({ meta: { code: 200 }, response: { user: { uid: 1 } } })]);
  const client = new UntappdClient({ fetchImpl: impl, token: 'TOK', clientId: 'CID', clientSecret: 'CSEC' });
  await client.get('/user/info/chris');
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain('access_token=TOK');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/git/untappd-mcp && npx vitest run tests/client.test.ts -t 'token'`
Expected: FAIL — current `ClientOptions` has no `token`/`clientId`/`clientSecret`/`loginName` fields (TS compile error or runtime: login is attempted).

- [ ] **Step 3: Rewrite the credential handling in `src/client.ts`**

Replace the `Credentials`/`readCredentials`/`ClientOptions` block and the constructor with discrete, individually-overridable fields. Full replacement of the relevant section:

```ts
export interface ClientOptions {
  /** Injectable fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Pre-seed the access token so no xauth login is performed. */
  token?: string;
  /** App credentials (xauth + write-path query). Default to env. */
  clientId?: string;
  clientSecret?: string;
  /** User login (xauth only). Default to env. */
  username?: string;
  password?: string;
  /** Default username for user-scoped tools; defaults to `username`. */
  loginName?: string;
}

export class UntappdClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly username: string | null;
  private readonly password: string | null;
  private readonly _loginName: string | null;
  private readonly utv = readEnvVar('UNTAPPD_UTV') ?? DEFAULTS.utv;
  private readonly deviceUdid = readEnvVar('UNTAPPD_DEVICE_ID') ?? DEFAULTS.deviceUdid;
  private readonly userAgent = readEnvVar('UNTAPPD_USER_AGENT') ?? DEFAULTS.userAgent;

  private token: string | null;
  private loginInFlight: Promise<string> | null = null;

  constructor(opts: ClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.token = opts.token ?? null;
    this.clientId = opts.clientId ?? readEnvVar('UNTAPPD_CLIENT_ID') ?? null;
    this.clientSecret = opts.clientSecret ?? readEnvVar('UNTAPPD_CLIENT_SECRET') ?? null;
    this.username = opts.username ?? readEnvVar('UNTAPPD_USERNAME') ?? null;
    this.password = opts.password ?? readEnvVar('UNTAPPD_PASSWORD') ?? null;
    this._loginName = opts.loginName ?? this.username;
  }

  /** True when enough is configured to make authenticated calls. */
  get configured(): boolean {
    // A pre-seeded token needs only app creds (for writes); otherwise a full login is required.
    if (this.token) return Boolean(this.clientId && this.clientSecret);
    return Boolean(this.clientId && this.clientSecret && this.username && this.password);
  }

  get loginName(): string | null {
    return this._loginName;
  }

  private requireAppCreds(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw missingCredsError();
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  private requireLogin(): { username: string; password: string; clientId: string; clientSecret: string } {
    const app = this.requireAppCreds();
    if (!this.username || !this.password) throw missingCredsError();
    return { ...app, username: this.username, password: this.password };
  }
```

Then update the two internal call sites:
- In `login()`: replace `const c = this.requireCreds();` with `const c = this.requireLogin();` (the rest — `c.clientId`, `c.clientSecret`, `c.username`, `c.password` — is unchanged).
- In `request()` bearer branch: replace `const c = this.requireCreds();` with `const c = this.requireAppCreds();` (uses `c.clientId`, `c.clientSecret`).

Delete the old `interface Credentials`, `readCredentials()`, and the `private requireCreds()` method. Keep `missingCredsError()` but simplify it to list whichever of the four env vars are missing (it already does).

Keep the module-level `export const client = new UntappdClient();` at the bottom **for now** — Task 2 removes it once the tools no longer import it.

- [ ] **Step 4: Update the existing credential tests to the new options**

In `tests/client.test.ts`, the existing tests construct `new UntappdClient({ fetchImpl: impl, credentials: CREDS })` and `credentials: null`. Replace:
- `credentials: CREDS` → `username: 'chris', password: 'pw', clientId: 'CID', clientSecret: 'CSEC'`
- the "throws a config error … when credentials are absent" test: construct `new UntappdClient({ fetchImpl: impl, clientId: null, clientSecret: null, username: null, password: null })` and keep asserting `client.configured === false` and that `get` rejects with `/credentials/i` making no network call. (Passing `null` explicitly overrides any ambient env.)

Delete the now-unused `const CREDS = {...}` if nothing references it.

- [ ] **Step 5: Run the client tests to verify they pass**

Run: `cd ~/git/untappd-mcp && npx vitest run tests/client.test.ts`
Expected: PASS (all cases, including the two new token-seeded ones).

- [ ] **Step 6: Commit**

```bash
cd ~/git/untappd-mcp
git add src/client.ts tests/client.test.ts
git commit -m "refactor: construct UntappdClient from discrete token/app/user creds

Enables building a per-user client from a pre-obtained token + app credentials
(no password) for the forthcoming remote connector, while preserving the
env-based stdio path and the deferred-config error.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Inject the client into every tool registrar

Remove the `client` singleton import from the tool files; each registrar takes the client as a second parameter. `src/index.ts` builds the env client once and passes it via closures. Update all tests to pass a client.

**Files:**
- Modify: `src/tools/beer.ts`, `src/tools/brewery.ts`, `src/tools/venue.ts`, `src/tools/user.ts`, `src/tools/feed.ts`, `src/tools/discover.ts`, `src/tools/checkin.ts`, `src/tools/wishlist.ts`, `src/tools/friends.ts`, `src/tools/resolve.ts`, `src/tools/utilities.ts`
- Modify: `src/index.ts`
- Modify: `src/client.ts` (remove the singleton export)
- Test: `tests/index.test.ts`, `tests/tools/read.test.ts`, `tests/tools/write.test.ts`, `tests/tools/friends.test.ts`, `tests/tools/resolve.test.ts`, `tests/server-boot.test.ts`

**Interfaces:**
- Consumes: `UntappdClient` and `ClientOptions` from Task 1.
- Produces: every registrar has signature `registerXxxTools(server: McpServer, client: UntappdClient): void`. No module-level `client` export remains in `src/client.ts`.

- [ ] **Step 1: Update the tool registrars (mechanical, all 11 files)**

For EACH file listed under "Modify … src/tools/*", apply exactly two edits:
1. Delete the line `import { client } from '../client.js';`.
2. Add a typed import and change the registrar signature to accept the client. At the top, add:
   ```ts
   import type { UntappdClient } from '../client.js';
   ```
   and change `export function registerXxxTools(server: McpServer): void {` to
   `export function registerXxxTools(server: McpServer, client: UntappdClient): void {`.

Every `client.get(...)`, `client.write(...)`, `client.putBinary(...)`, `client.loginName`, `client.configured` reference inside the function body is now the parameter — no other body changes. `resolve.ts` already imports `client` for `untappd_open_url`; it gets the same treatment (its `parseUntappdUrl` export is unaffected).

- [ ] **Step 2: Rewire `src/index.ts` to build and inject the client**

Replace the `tools: [...]` wiring so each registrar is called with the env client. Full new `src/index.ts`:

```ts
#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { UntappdClient } from './client.js';
import { registerBeerTools } from './tools/beer.js';
import { registerBreweryTools } from './tools/brewery.js';
import { registerVenueTools } from './tools/venue.js';
import { registerUserTools } from './tools/user.js';
import { registerFeedTools } from './tools/feed.js';
import { registerResolveTools } from './tools/resolve.js';
import { registerDiscoverTools } from './tools/discover.js';
import { registerFriendActionTools } from './tools/friends.js';
import { registerWishlistTools } from './tools/wishlist.js';
import { registerCheckinTools } from './tools/checkin.js';
import { registerUtilityTools } from './tools/utilities.js';

// Build the env-based client once and inject it into each registrar. The
// constructor defers its config error, so the server still boots (and answers
// the host's install-time tools/list probe) when credentials are absent.
const client = new UntappdClient();

await runMcp({
  name: 'untappd-mcp',
  version: VERSION,
  banner:
    '[untappd-mcp] This project was developed and is maintained by AI (Claude Opus 4.8). Use at your own discretion.',
  tools: [
    (s) => registerBeerTools(s, client),
    (s) => registerBreweryTools(s, client),
    (s) => registerVenueTools(s, client),
    (s) => registerUserTools(s, client),
    (s) => registerFeedTools(s, client),
    (s) => registerResolveTools(s, client),
    (s) => registerDiscoverTools(s, client),
    (s) => registerFriendActionTools(s, client),
    (s) => registerWishlistTools(s, client),
    (s) => registerCheckinTools(s, client),
    (s) => registerUtilityTools(s, client),
  ],
});
```

- [ ] **Step 3: Remove the singleton export from `src/client.ts`**

Delete the trailing block:
```ts
export const client = new UntappdClient();
```
(and its doc comment). `src/client.ts` now exports only `UntappdClient`, `ClientOptions`, and `Query`.

- [ ] **Step 4: Update the tests to pass a client**

The tool tests currently `import { client } from '../../src/client.js'` and `vi.spyOn(client, 'get'|'write')`. Change each affected test file to construct a local client and pass it to the registrars:

In `tests/tools/read.test.ts`, `tests/tools/write.test.ts`, `tests/tools/friends.test.ts`:
1. Replace `import { client } from '../../src/client.js';` with `import { UntappdClient } from '../../src/client.js';` and add `const client = new UntappdClient();`.
2. In the `createTestHarness((server) => { registerXxxTools(server); ... })` setup, pass `client`: `registerXxxTools(server, client)`.
The `vi.spyOn(client, 'get')` / `vi.spyOn(client, 'write')` / `vi.spyOn(client, 'loginName', 'get')` calls are unchanged (they now spy on the local instance).

In `tests/tools/resolve.test.ts` (the `untappd_open_url` block): same treatment — `const client = new UntappdClient()`, spy on it, `registerResolveTools(server, client)`.

In `tests/index.test.ts`: add `import { UntappdClient } from '../src/client.js';` and `const client = new UntappdClient();`, then pass `client` as the second arg to each `registerXxxTools(server, ...)` call in the harness setup. Tool count assertions are unchanged (37).

`tests/server-boot.test.ts` spawns the built binary and needs no source change (it exercises `dist/`), but it depends on the build — covered in Step 6.

- [ ] **Step 5: Run the full test suite to verify it passes**

Run: `cd ~/git/untappd-mcp && npm test`
Expected: PASS — same test count as before plus Task 1's two new tests; no `client is not defined` or type errors.

- [ ] **Step 6: Build and run the boot smoke test against real artifacts**

Run: `cd ~/git/untappd-mcp && npm run build && npx vitest run tests/server-boot.test.ts`
Expected: PASS — the bundled `dist/bundle.js` and `dist/index.js` both boot and list ≥ 18 tools including `untappd_healthcheck`. (This proves the closure wiring compiles and the singleton removal didn't break the entry point.)

- [ ] **Step 7: Commit**

```bash
cd ~/git/untappd-mcp
git add src/ tests/
git commit -m "refactor: inject the client into every tool registrar

registerXxxTools(server, client) instead of importing a module-level singleton;
index.ts builds the env client once and threads it in. Removes global state and
lets a per-user client be injected by the remote connector worker. No behavior
or roster change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Delivery

Both tasks land as a single PR off `main` (they are one coherent refactor; splitting the commits keeps review legible). Open the PR, let the auto-review pipeline ship it — do NOT merge or add `ready-to-merge` manually. Expected roster on `main` afterward: unchanged (37 tools), all tests green, stdio server behavior identical.

## Self-review notes

- **Spec coverage:** implements spec §4.1 (injected client) and §4.2 (client construction for the write path without a password). Spec §3 (harness), §5–§7 (worker/data-flow/deploy) are **Plan 2**, intentionally out of scope here.
- **Type consistency:** `registerXxxTools(server, client: UntappdClient)` is used identically in every tool file, `index.ts`, and every test harness setup. `configured`/`loginName` getters and `get`/`write`/`putBinary` method names match Task 1 → Task 2 → tests.
- **No placeholders:** every step shows the exact code/edit; the multi-file registrar change (Task 2 Step 1) is a precise two-edit transformation enumerated across all 11 files, not a "similar to" hand-wave.
