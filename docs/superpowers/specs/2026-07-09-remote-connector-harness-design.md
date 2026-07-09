# Design: Reusable fleet remote-connector harness (Untappd as first consumer)

**Date:** 2026-07-09
**Status:** Approved (design); pending spec review

## 1. Goal

Make `untappd-mcp` usable from the **Claude mobile app** (and web/desktop) as an
**unlisted, shareable remote connector** where each user logs in with their own
Untappd **username/password**.

Because the Claude mobile app only supports **remote** connectors (added by URL
in a claude.ai account, then synced to web/desktop/mobile) — not `.mcpb` Desktop
Extensions — the hosted server is the primary deliverable.

**Overarching goal (per owner):** this should generalize. The owner intends to
turn *more* fleet MCPs into remote connectors over time. So the real deliverable
is a **reusable connector harness** — a shared library that turns any fleet MCP
into a Cloudflare-hosted remote connector with a thin (~30-line) per-repo entry —
and Untappd is its first consumer and proof.

## 2. Non-goals

- Public directory listing / marketplace submission (audience is unlisted-shareable).
- OAuth *to* Untappd (Untappd has no consumer OAuth; we use its xauth login).
- Migrating other fleet repos in this project (future work; each its own spec/plan).
- A full privacy/ToS/legal program (a one-line in-page privacy note suffices at this scale).

## 3. Architecture

### 3.1 The reusable harness — `@chrischall/mcp-connector` (new package)

A new shared package (sibling to `@chrischall/mcp-utils`; kept separate so the
Cloudflare/Workers-runtime dependencies never leak into the zero-dep mcp-utils
core). It is to remote connectors what `runMcp` is to stdio servers: the repo
declares *what* it exposes; the harness owns *how* it's served and authenticated.

It exports one entry, `runConnector(options)`, for a Cloudflare Worker:

```ts
export interface ConnectorAuth<Props> {
  service: string;                      // branding for the login page, e.g. "Untappd"
  fields: LoginField[];                 // e.g. [{name:'username'}, {name:'password', type:'password'}]
  /** Exchange the submitted login fields for the props we persist (encrypted). */
  login(fields: Record<string,string>, env: Env): Promise<Props>;   // e.g. xauth → { token, username }
}

export interface ConnectorOptions<Props, Client> {
  name: string;
  version: string;
  auth: ConnectorAuth<Props>;
  /** Build the per-user MCP client from the stored props + Worker env (secrets). */
  buildClient(props: Props, env: Env): Client;
  /** The SAME tool registrars used by the stdio server. */
  tools: Array<(server: McpServer, client: Client) => void>;
}

export function runConnector<P, C>(opts: ConnectorOptions<P, C>): ExportedHandler;
```

Internally the harness wires, using the current Cloudflare remote-MCP stack:

- **`@cloudflare/workers-oauth-provider`** — OAuth 2.1 authorization server:
  dynamic client registration, PKCE, `/.well-known/*` metadata, `/authorize`,
  `/token`. This is what Claude's "add custom connector" flow discovers and drives.
- **Login page** — a minimal server-rendered HTML form generated from
  `auth.fields` + `auth.service` branding, plus a consent button. On POST, the
  harness calls `auth.login(fields, env)` and, on success,
  `completeAuthorization({ props })`. The provider encrypts `props` and binds
  them to the issued token. **Raw login fields (passwords) are never persisted.**
- **`McpAgent`** (from the `agents` SDK; a Durable Object) — serves streamable
  HTTP at `/mcp`. Per authenticated session it calls `buildClient(props, env)`
  and registers every `tools[]` registrar against the resulting client.
- **KV** — the provider's token/grant store (encrypted props live here). No
  separate database.

> The exact `workers-oauth-provider` / `McpAgent` API surface (constructor
> shapes, `completeAuthorization` signature, DO bindings) will be confirmed
> against **current Cloudflare docs during plan-writing** — the `agents-sdk` /
> `cloudflare` skills require retrieval over memory. The abstraction above is the
> stable contract; harness internals adapt to the current APIs.

### 3.2 Why this generalizes across the fleet

`ConnectorAuth.login` + `buildClient` map cleanly onto the existing fleet auth
archetypes, so each future repo supplies only those two functions + its field
list:

| Fleet archetype | `fields` | `login` returns props | `buildClient` |
| --- | --- | --- | --- |
| username/password → token (untappd) | username, password | `{ token, username }` | `new UntappdClient({ token, ... })` |
| bearer / API-key (splitwise, tempo) | apiKey | `{ apiKey }` | `new XClient({ apiKey })` |
| cookie-session (artsonia, canvas) | username, password | `{ cookie }` | client seeded with the cookie jar |

The harness itself is auth-agnostic. Adding a connector = a `worker.ts` that
imports the repo's existing tool registrars + client and declares these three
things.

### 3.3 Untappd consumer

- `src/worker.ts` (untappd-mcp): `runConnector({ name, version, auth: untappdAuth, buildClient, tools: [...] })`.
- `untappdAuth`: `fields = [username, password]`; `login` runs **xauth** using the
  **operator's** `env.UNTAPPD_CLIENT_ID` / `env.UNTAPPD_CLIENT_SECRET` + the
  submitted username/password → `{ token, username }`. Users supply only their
  Untappd username/password; the operator supplies the app credentials once as a
  Worker secret.
- `buildClient(props, env)` → `new UntappdClient({ token: props.token, clientId: env.UNTAPPD_CLIENT_ID, clientSecret: env.UNTAPPD_CLIENT_SECRET, loginName: props.username })`.
- `wrangler.jsonc` + a KV namespace + secrets (`UNTAPPD_CLIENT_ID`,
  `UNTAPPD_CLIENT_SECRET`, provider signing key).

## 4. Prerequisite refactors (in `untappd-mcp`)

These are needed for tool reuse across stdio + worker, and are improvements in
their own right (they remove global state):

1. **Injected client.** `registerXxxTools(server)` → `registerXxxTools(server, client)`;
   drop the module-level `client` singleton import from every tool file. The
   stdio `index.ts` builds the env-based client and passes it; the worker passes
   the per-user client. `resolveUser` reads `client.loginName`.
2. **Client construction for the write path without a password.** `UntappdClient`
   currently reads all four credentials from env and requires the password. The
   worker constructs a client from `{ token, clientId, clientSecret, loginName }`
   (no password — it already has the token; `clientId`/`secret` are still needed
   for the write path's query params). Expand `ClientOptions` to accept these
   discrete fields; a pre-seeded `token` means no password is required.

Both land as their own PR **before** the worker, keeping the stdio server green
throughout (it's the published product).

## 5. Data flow (add + use)

1. User adds the connector URL in claude.ai / mobile → Connectors.
2. Claude fetches OAuth metadata, dynamic-registers, opens `/authorize` in the browser.
3. User sees the Untappd login page, enters username + password, submits.
4. Worker runs xauth → the user's Untappd access token → `completeAuthorization({ props:{ token, username } })`.
5. Claude receives its own bearer token, stored per-user and synced across surfaces.
6. Tool calls hit `/mcp` with that token → provider decrypts props → `McpAgent`
   builds the per-user `UntappdClient` → tool runs.

## 6. Credential handling / security

- Operator supplies Untappd app credentials (Worker secret). **Users supply only
  username/password.**
- Password is used once for xauth at login and **never persisted**; only the
  Untappd access token is stored, encrypted, in the OAuth props.
- Unlisted (URL-only) → small blast radius. Untappd's per-token rate limits apply
  per user.
- The login page shows a one-line privacy note: the password signs you in and is
  not stored; only an access token is kept to act on your behalf.

## 7. Testing

- **Existing unit tests** carry over, adapted to the injected client (pass a
  client instead of the singleton).
- **Harness:** unit-test the login→props flow with a mock `login`, and the login
  page rendering from `fields`.
- **Untappd auth:** unit-test `untappdAuth.login` (mock fetch → xauth → props).
- **Worker handshake:** an `initialize` + `tools/list` round-trip through the
  Worker via `@cloudflare/vitest-pool-workers`.
- **Manual gate:** deploy to a `*.workers.dev` URL; add it as a connector on
  **mobile + web**; log in with a real Untappd account; run a read
  (`untappd_search_beer`) and a confirm-gated write dry-run.

## 8. Scope & phasing (each phase = its own PR)

This spec is one vertical slice: get Untappd working as a remote connector on
mobile, on a harness built for reuse.

1. **Refactor** — injected client + `ClientOptions` expansion in `untappd-mcp`. Stdio stays green.
2. **Harness** — `@chrischall/mcp-connector` MVP: `runConnector`, OAuth provider
   wiring, generated login page, `McpAgent` glue. Covers the username/password
   archetype (bearer/cookie designed-for but proven later).
3. **Untappd worker** — `src/worker.ts` + `wrangler.jsonc` + secrets → deploy →
   verify on mobile.

**Follow-ups (separate specs/plans, not this one):**
- `.mcpb` Desktop Extension polish (desktop-only bonus; decide client-cred handling).
- Migrating a second fleet repo (e.g. splitwise/bearer) onto the harness — the
  real test of the abstraction.

## 9. Open questions deferred to plan-writing

- Exact current `workers-oauth-provider` + `agents`/`McpAgent` APIs and bindings.
- Where the harness package physically lives (standalone repo vs. mcp-utils
  monorepo) and how it's built for the Workers runtime.
- Whether the `.mcpb` bakes the operator client creds or keeps asking for all four.
