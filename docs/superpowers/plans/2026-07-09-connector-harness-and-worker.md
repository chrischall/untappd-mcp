# Connector Harness + Untappd Worker Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the reusable `@chrischall/mcp-connector` harness and wire `untappd-mcp` into a Cloudflare Worker so the server runs as an unlisted remote connector where each user logs in with their own Untappd username/password (works on the Claude mobile app, web, and desktop).

**Architecture:** A new package `@chrischall/mcp-connector` exposes `createConnector(opts)`, which returns `{ Agent, handler }`: `Agent` is an `McpAgent` subclass whose `init()` builds a per-user client via `opts.buildClient(this.props, this.env)` and registers `opts.tools` against `this.server`; `handler` is a `@cloudflare/workers-oauth-provider` `OAuthProvider` whose custom `defaultHandler` renders a login form from `opts.auth.fields`, verifies via `opts.auth.login()`, and stores the resulting props. `untappd-mcp`'s `src/worker.ts` supplies three things (Untappd xauth login, `buildClient`, the existing tool registrars) and re-exports the `Agent` class for the Durable Object binding.

**Tech Stack:** Cloudflare Workers, `agents` (`McpAgent`), `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk` `McpServer`, `wrangler`, `@cloudflare/vitest-pool-workers`, TypeScript.

## Global Constraints

- **Verified Cloudflare API (do not deviate without re-checking docs):**
  - `new OAuthProvider({ apiHandlers, defaultHandler, authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register' })`.
  - Login: `const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request)`; after verifying creds, `const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: oauthReqInfo, userId, scope: [], metadata: {}, props })`; `return Response.redirect(redirectTo, 302)`.
  - `McpAgent<Env, State, Props>` subclass: `server = new McpServer({name, version})`, `async init()`, props at `this.props`, env at `this.env`. Mount via `Agent.serve('/mcp')` and `Agent.serveSSE('/sse')`.
  - wrangler: `compatibility_flags: ["nodejs_compat"]`, a Durable Object binding `MCP_OBJECT` → the Agent class, a migration `new_sqlite_classes: ["<AgentClass>"]`, and a KV namespace bound as `OAUTH_KV`.
- The harness is auth-agnostic: it must not import anything Untappd-specific. Its only knowledge is the `ConnectorOptions` contract.
- Credentials: the login password is used once to obtain props and is NEVER persisted; only the resulting props (e.g. the Untappd token) are stored (encrypted by OAuthProvider). The operator's Untappd `client_id`/`client_secret` are Worker secrets, not per-user input.
- No secrets committed. `wrangler.jsonc` holds only the KV namespace **id** (not secret) and bindings; `UNTAPPD_CLIENT_ID`/`UNTAPPD_CLIENT_SECRET` are set via `wrangler secret put`.
- The existing stdio server, its 37-tool roster, and `npm test` stay green — the worker is additive.
- ESM + NodeNext for the stdio package; the worker/harness are bundled by wrangler/esbuild.

---

### Task 1: Scaffold `@chrischall/mcp-connector` with `createConnector`

Create the reusable harness package with the `ConnectorOptions` contract, the login-page renderer, the OAuth default handler, and the McpAgent glue. Unit-test the auth/login flow and the login-page rendering with mocks (no real Workers runtime needed for these).

**Files:**
- Create: `packages/mcp-connector/package.json`, `packages/mcp-connector/tsconfig.json`, `packages/mcp-connector/src/index.ts`, `packages/mcp-connector/src/login-page.ts`, `packages/mcp-connector/src/types.ts`
- Test: `packages/mcp-connector/tests/login.test.ts`, `packages/mcp-connector/tests/login-page.test.ts`

> **Decision (from spec §3.1, confirmed):** the harness is a **standalone package** so Cloudflare/Workers deps never enter the zero-dep `@chrischall/mcp-utils` core. It lives here under `packages/` for now (a local path-linked package the worker consumes via `file:`); publishing to npm is a later step, not required to build/deploy the worker.

**Interfaces:**
- Consumes: `McpAgent` from `agents`, `OAuthProvider` from `@cloudflare/workers-oauth-provider`, `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
- Produces (`src/types.ts`):
  ```ts
  export interface LoginField { name: string; label: string; type?: 'text' | 'password'; }
  export interface ConnectorAuth<Props> {
    service: string;                 // login-page branding, e.g. "Untappd"
    fields: LoginField[];
    login(fields: Record<string, string>, env: any): Promise<Props>;  // throws on bad creds
    privacyNote?: string;            // one-line note shown under the form
  }
  export interface ConnectorOptions<Props, Client> {
    name: string;
    version: string;
    auth: ConnectorAuth<Props>;
    buildClient(props: Props, env: any): Client;
    tools: Array<(server: any, client: Client) => void>;
  }
  ```
- Produces (`src/index.ts`): `createConnector<Props, Client>(opts): { Agent: typeof McpAgent; handler: OAuthProvider }` and re-exports the types. Also exports `renderLoginPage(auth, opts?)` and `parseLoginForm(request)` for testability.

- [ ] **Step 1: Write the failing login-flow test**

`packages/mcp-connector/tests/login.test.ts` — test the default handler's POST path in isolation by extracting it. Create `src/login.ts` exporting `handleAuthorize(request, env, auth)` that: on GET renders the form; on POST parses fields, calls `auth.login(fields, env)`, then `env.OAUTH_PROVIDER.completeAuthorization({...})` and redirects. Test with a fake `env.OAUTH_PROVIDER`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleAuthorize } from '../src/login.js';

const auth = {
  service: 'Untappd',
  fields: [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password', type: 'password' as const }],
  login: vi.fn(async (f: Record<string,string>) => ({ token: 'TOK', username: f.username })),
};

function fakeEnv() {
  return { OAUTH_PROVIDER: {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'c', redirectUri: 'https://claude.ai/cb', scope: [], state: 's' })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://claude.ai/cb?code=xyz' })),
  }};
}

it('POST /authorize verifies creds and completes authorization with props', async () => {
  const env = fakeEnv();
  const body = new URLSearchParams({ username: 'chris', password: 'pw', oauthReq: btoa(JSON.stringify({ clientId: 'c' })) });
  const req = new Request('https://x/authorize', { method: 'POST', body });
  const res = await handleAuthorize(req, env, auth);
  expect(auth.login).toHaveBeenCalledWith({ username: 'chris', password: 'pw' }, env);
  expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({ props: { token: 'TOK', username: 'chris' }, userId: 'chris' }),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('code=xyz');
});

it('POST with bad creds re-renders the form with an error (no completeAuthorization)', async () => {
  const env = fakeEnv();
  const badAuth = { ...auth, login: vi.fn(async () => { throw new Error('login failed'); }) };
  const body = new URLSearchParams({ username: 'x', password: 'y', oauthReq: btoa(JSON.stringify({ clientId: 'c' })) });
  const req = new Request('https://x/authorize', { method: 'POST', body });
  const res = await handleAuthorize(req, env, badAuth);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('login failed');
  expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/mcp-connector && npx vitest run tests/login.test.ts`
Expected: FAIL — `src/login.ts`/`handleAuthorize` do not exist.

- [ ] **Step 3: Implement `src/login-page.ts`, `src/login.ts`, `src/types.ts`**

`login-page.ts` — `renderLoginPage(auth, { error?, oauthReq })` returns an HTML string: a `<form method="post">` with one `<input name=...>` per `auth.fields` (password fields `type="password"`), a hidden `oauthReq` field carrying `btoa(JSON.stringify(oauthReqInfo))`, the `auth.service` name in the heading, `auth.privacyNote` under the form, and (if `error`) the error text in a visible element.

`login.ts` — `handleAuthorize(request, env, auth)`:
- GET: `const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request); return new Response(renderLoginPage(auth, { oauthReq: oauthReqInfo }), { headers: {'content-type':'text/html'} });`
- POST: parse `await request.formData()`; pull each `auth.fields` value into `fields`; read+decode the hidden `oauthReq`; then `try { const props = await auth.login(fields, env); const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: oauthReqInfo, userId: fields[auth.fields[0].name], scope: [], metadata: {}, props }); return Response.redirect(redirectTo, 302); } catch (e) { return new Response(renderLoginPage(auth, { error: messageOf(e), oauthReq: oauthReqInfo }), { status: 200, headers: {'content-type':'text/html'} }); }`
- (Add a small local `messageOf`; do not depend on mcp-utils here to keep the harness dependency-light.)

`types.ts` — the interfaces from the Interfaces block.

- [ ] **Step 4: Run login tests green**

Run: `cd packages/mcp-connector && npx vitest run tests/login.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Write + pass the login-page rendering test**

`tests/login-page.test.ts`: assert `renderLoginPage` output contains an input for each field, `type="password"` on password fields, the service name, the privacy note, and (when passed) the error string. Implement any gaps. Run green.

- [ ] **Step 6: Implement `src/index.ts` (`createConnector`) — the McpAgent + OAuthProvider glue**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleAuthorize } from './login.js';
import type { ConnectorOptions } from './types.js';
export * from './types.js';
export { renderLoginPage } from './login-page.js';
export { handleAuthorize } from './login.js';

export function createConnector<Props, Client>(opts: ConnectorOptions<Props, Client>) {
  class ConnectorAgent extends McpAgent<any, unknown, Props> {
    server = new McpServer({ name: opts.name, version: opts.version });
    async init() {
      const client = opts.buildClient(this.props as Props, this.env);
      for (const register of opts.tools) register(this.server, client);
    }
  }
  const defaultHandler = {
    fetch: (request: Request, env: any) => {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') return handleAuthorize(request, env, opts.auth);
      return new Response('Not found', { status: 404 });
    },
  };
  const handler = new OAuthProvider({
    apiHandlers: {
      '/mcp': ConnectorAgent.serve('/mcp') as any,
      '/sse': ConnectorAgent.serveSSE('/sse') as any,
    },
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
  });
  return { Agent: ConnectorAgent, handler };
}
```

Do NOT write a runtime test that instantiates `McpAgent`/`OAuthProvider` here (they need the Workers runtime — that is Task 2's `vitest-pool-workers` handshake). A `tsc --noEmit` on the package is the compile-time gate for this step.

- [ ] **Step 7: package.json / tsconfig, typecheck, commit**

`package.json`: name `@chrischall/mcp-connector`, `type: module`, `exports` → `./dist/index.js`, deps `agents`, `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`; devDeps `typescript`, `vitest`, `@cloudflare/workers-types`. `tsconfig.json`: NodeNext, `types: ["@cloudflare/workers-types"]`.

Run: `cd packages/mcp-connector && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all unit tests pass.

```bash
git add packages/mcp-connector
git commit -m "feat(mcp-connector): reusable Cloudflare remote-connector harness

createConnector(opts) → { Agent, handler }: an McpAgent that builds a per-user
client from OAuth props + registers the repo's tools, behind a
workers-oauth-provider whose custom login page collects the service's own
credentials. Auth-agnostic; unit-tested login + page rendering.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Untappd worker consumer + local handshake test

Add `src/worker.ts` (Untappd xauth login + buildClient + tools), `wrangler.jsonc`, worker deps, and a `vitest-pool-workers` test that runs the MCP `initialize` + `tools/list` handshake against the real Worker with a mocked-out login.

**Files:**
- Create: `src/worker.ts`, `src/untappd-auth.ts`, `wrangler.jsonc`, `.dev.vars.example`, `tests/worker.test.ts`, `vitest.workers.config.ts`
- Modify: `package.json` (add worker deps + a `deploy` script; add `@chrischall/mcp-connector` via `file:./packages/mcp-connector`)

**Interfaces:**
- Consumes: `createConnector` from `@chrischall/mcp-connector`; `UntappdClient` from `./client.js`; every `registerXxxTools` from `./tools/*`.
- Produces: `src/worker.ts` default-exports the OAuth handler and re-exports `UntappdMcpAgent` (the `Agent` from `createConnector`) for the DO binding. `src/untappd-auth.ts` exports `untappdAuth: ConnectorAuth<{ token: string; username: string }>` whose `login` does xauth.

- [ ] **Step 1: Write `src/untappd-auth.ts` (xauth login as a ConnectorAuth) + its test**

`untappd-auth.ts`:
```ts
import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { UntappdClient } from './client.js';

export interface UntappdProps { token: string; username: string; }

export const untappdAuth: ConnectorAuth<UntappdProps> = {
  service: 'Untappd',
  privacyNote: 'Your password signs you in once and is not stored — only an access token is kept to make requests on your behalf.',
  fields: [
    { name: 'username', label: 'Untappd username or email' },
    { name: 'password', label: 'Untappd password', type: 'password' },
  ],
  async login(fields, env) {
    const token = await UntappdClient.xauthLogin({
      username: fields.username,
      password: fields.password,
      clientId: env.UNTAPPD_CLIENT_ID,
      clientSecret: env.UNTAPPD_CLIENT_SECRET,
    });
    return { token, username: fields.username };
  },
};
```
This needs a static `UntappdClient.xauthLogin({username,password,clientId,clientSecret}): Promise<string>` that performs the one-shot xauth POST and returns the access token (reusing the existing login internals). Add it to `src/client.ts` as a thin static that constructs a client and calls a package-private login, OR extract the xauth POST into a standalone exported `xauthLogin` helper. Prefer a standalone exported function `xauthLogin(creds, opts?)` in `client.ts` reused by both the instance `login()` and this static path — DRY. Test `untappd-auth.login` with a mock fetch (xauth → token) exactly like the existing client login test.

- [ ] **Step 2: Write `src/worker.ts`**

```ts
import { createConnector } from '@chrischall/mcp-connector';
import { VERSION } from './version.js';
import { UntappdClient } from './client.js';
import { untappdAuth, type UntappdProps } from './untappd-auth.js';
import { registerBeerTools } from './tools/beer.js';
// ...import every registrar exactly as index.ts does...

const { Agent, handler } = createConnector<UntappdProps, UntappdClient>({
  name: 'untappd-mcp',
  version: VERSION,
  auth: untappdAuth,
  buildClient: (props, env) => new UntappdClient({
    token: props.token,
    clientId: env.UNTAPPD_CLIENT_ID,
    clientSecret: env.UNTAPPD_CLIENT_SECRET,
    loginName: props.username,
  }),
  tools: [
    registerBeerTools, registerBreweryTools, registerVenueTools, registerUserTools,
    registerFeedTools, registerResolveTools, registerDiscoverTools, registerFriendActionTools,
    registerWishlistTools, registerCheckinTools, registerUtilityTools,
  ],
});

export { Agent as UntappdMcpAgent };
export default handler;
```

- [ ] **Step 3: Write `wrangler.jsonc`**

```jsonc
{
  "name": "untappd-connector",
  "main": "src/worker.ts",
  "compatibility_date": "2025-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "MCP_OBJECT", "class_name": "UntappdMcpAgent" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UntappdMcpAgent"] }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<created-in-deploy-step>" }]
}
```
`.dev.vars.example`: `UNTAPPD_CLIENT_ID=` / `UNTAPPD_CLIENT_SECRET=` (real values go in `.dev.vars`, gitignored, for local `wrangler dev`). Add `.dev.vars` to `.gitignore`.

- [ ] **Step 4: Add worker deps + scripts to package.json**

deps: `@chrischall/mcp-connector: file:./packages/mcp-connector`. devDeps: `wrangler`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`. scripts: `"worker:dev": "wrangler dev"`, `"worker:deploy": "wrangler deploy"`, `"worker:test": "vitest run --config vitest.workers.config.ts"`. Run `npm install` (links the local package).

- [ ] **Step 5: Write the Worker handshake test (`vitest-pool-workers`)**

`vitest.workers.config.ts` uses `@cloudflare/vitest-pool-workers` pointing at `wrangler.jsonc`. `tests/worker.test.ts`: use `SELF.fetch()` to POST an MCP `initialize` then `tools/list` to `/mcp` with a stubbed OAuth token whose props are `{ token: 'X', username: 'u' }`. Because the OAuth layer is hard to fake end-to-end in-process, scope this test to the Agent: import `UntappdMcpAgent`, or assert that an unauthenticated `/mcp` request is rejected (401/redirect) and that `GET /authorize` returns the login HTML containing "Untappd" and both field labels. Assert the tool count is 37 if the harness exposes an introspection path; otherwise assert the login-page + unauthorized behavior. Keep this test hermetic (no real Untappd calls).

- [ ] **Step 6: Verify stdio suite still green + worker test passes + typecheck**

Run: `npm test && npm run build && npx tsc --noEmit && npm run worker:test`
Expected: stdio 92+ tests green, build ok, typecheck clean, worker test green.

- [ ] **Step 7: Commit**

```bash
git add src/worker.ts src/untappd-auth.ts src/client.ts wrangler.jsonc .dev.vars.example .gitignore package.json package-lock.json vitest.workers.config.ts tests/worker.test.ts
git commit -m "feat: Untappd Cloudflare remote-connector worker

src/worker.ts wires the tools + xauth login + per-user client into
@chrischall/mcp-connector; wrangler.jsonc binds the McpAgent DO + OAUTH_KV.
Local vitest-pool-workers handshake covers the login page + unauthorized path.
Stdio server unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Deploy runbook (human-gated) + docs

Document the exact deploy steps. The actual deploy requires the owner's Cloudflare account and cannot be done by an agent; this task produces the runbook and the README section, and defines the manual verification gate.

**Files:**
- Create: `docs/DEPLOY-CONNECTOR.md`
- Modify: `README.md` (add a "Remote connector" section)

- [ ] **Step 1: Write `docs/DEPLOY-CONNECTOR.md`** with these exact operator steps:
  1. `npx wrangler login` (owner's Cloudflare account).
  2. `npx wrangler kv namespace create OAUTH_KV` → copy the `id` into `wrangler.jsonc`.
  3. `npx wrangler secret put UNTAPPD_CLIENT_ID` and `... UNTAPPD_CLIENT_SECRET` (the operator's captured app credentials).
  4. `npm run worker:deploy` → note the `https://untappd-connector.<subdomain>.workers.dev` URL.
  5. In claude.ai → Settings → Connectors → Add custom connector → paste `https://…workers.dev/mcp`. Complete the Untappd login when prompted.
  6. Verify on the **mobile app**: the connector appears, and `untappd_search_beer` / a dry-run write work.
  7. Rotation/teardown notes: `wrangler secret delete`, `wrangler kv namespace delete`.
- [ ] **Step 2: Add the README "Remote connector" section** summarizing what it is (unlisted shareable, per-user Untappd login) and linking `docs/DEPLOY-CONNECTOR.md`.
- [ ] **Step 3: Commit** the docs.

---

## Delivery

Tasks 1–2 land as one PR (harness + worker) off `main`; auto-review ships it. Task 3 (docs) can be the same PR. The **live deploy + mobile verification (Task 3 runbook)** is performed by the owner — surface it as the final human step; do not attempt `wrangler login`/`deploy` as an agent.

## Human dependencies (surface before execution)

- **Cloudflare account** for `wrangler login`, KV creation, secrets, and deploy.
- The **operator Untappd `client_id`/`client_secret`** set as Worker secrets (already captured; live in the local `.env`).
- Decision confirmed in spec: harness is a standalone `@chrischall/mcp-connector` package (here under `packages/`, path-linked; npm publish later).

## Self-review notes

- **Spec coverage:** implements spec §3.1 (harness), §3.3 (Untappd consumer), §5 (data flow via OAuthProvider→props→McpAgent), §6 (password used once, only token stored), §7 (login-flow unit tests + worker handshake), §8 phases 2–3. Spec §4 (refactor) was Plan 1.
- **API fidelity:** every Cloudflare call (`OAuthProvider` options, `parseAuthRequest`/`completeAuthorization`, `McpAgent.serve`, wrangler DO/migration/KV) is copied from the retrieved current docs (Global Constraints block).
- **Risk flagged for the implementer:** the exact import path for `McpAgent` (`agents/mcp`) and the OAuthProvider `apiHandlers` value type may need a small adjustment against the installed package versions — the implementer must `npm install` the real deps and follow their types; if an API differs from the Global Constraints block, STOP and report (do not guess).
