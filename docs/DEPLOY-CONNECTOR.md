# Deploying the Untappd remote connector

This is the operator runbook for standing up `untappd-mcp` as a hosted
Cloudflare Worker — a "remote connector" that anyone you share the URL with can
add to claude.ai (web, desktop, or mobile), each logging in with their own
Untappd account. Standing it up is a manual, one-time (per operator) process:
none of the steps below can be done by an agent, since they require your own
Cloudflare account. Once it's standing, though, deploys are automated — the
`deploy-connector` job in `.github/workflows/release-please.yml` redeploys the
Worker on every release, pinned to the release tag, and
`.github/workflows/deploy-connector.yml` gives an on-demand
**Actions → deploy-connector → Run workflow** path for any ref.

If you just want the server on your own machine talking only to your own
Untappd account, you don't need any of this — see the main
[README](../README.md) for the local stdio / `.mcpb` install instead, which is
the desktop-only alternative to running a shared connector.

## Prerequisites

- A Cloudflare account (free tier is fine).
- Node and this repo checked out with dependencies installed (`npm install`).
- Your Untappd mobile-app `client_id` / `client_secret` — the same values you
  captured for the local `.env` (see the README's "Obtaining the client id /
  secret" section). These are the *operator's* app credentials, shared by
  every user of the connector; they are separate from any individual user's
  Untappd username/password.

## Steps

### 1. Log in to Cloudflare

```sh
npx wrangler login
```

This opens a browser to authorize the CLI against your Cloudflare account.

### 2. Create the OAuth KV namespace

The connector stores OAuth state and per-user session data in a KV namespace
bound as `OAUTH_KV` (see `wrangler.jsonc`).

```sh
npx wrangler kv namespace create OAUTH_KV
```

The command prints something like:

```
{ "binding": "OAUTH_KV", "id": "abcd1234..." }
```

Copy the returned `id` into `wrangler.jsonc`, replacing the
`"placeholder-set-in-deploy"` value:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "abcd1234..." }],
```

### 3. Set the app-level secrets

The Worker needs your Untappd mobile-app credentials as Cloudflare secrets
(not committed to the repo, not the same as any user's own login):

```sh
npx wrangler secret put UNTAPPD_CLIENT_ID
npx wrangler secret put UNTAPPD_CLIENT_SECRET
```

Each prompts for a value on stdin — paste in the corresponding value from your
local `.env`.

### 4. Deploy

```sh
npm run worker:deploy
```

This runs `wrangler deploy`, which builds and pushes `src/worker.ts` (plus the
`UntappdMcpAgent` and `UntappdCacheDO` Durable Object bindings and the
`OAUTH_KV` namespace from step 2). On success it prints the deployed URL:

```
https://untappd-connector.<your-subdomain>.workers.dev
```

Note that URL — it's what you'll share and what gets added as a connector.

You only need to run this deploy by hand once, to get the Worker created under
your account. From then on CI redeploys it on release (and on demand from the
Actions tab); `npm run worker:deploy` stays available for pushing an unreleased
working tree from your own machine.

> **Check-in cache Durable Object.** The connector's `untappd_sync_checkins` /
> `untappd_cache_*` tools store each user's synced history in a `UntappdCacheDO`
> Durable Object with SQLite storage, keyed by the logged-in user so it persists
> across their conversations and is isolated from other users. Its binding and
> SQLite migration are declared in `wrangler.jsonc` and applied automatically by
> `wrangler deploy` — no extra setup. **If you are upgrading an existing
> deployment** that predates these tools, this deploy adds the `v2` migration
> (`new_sqlite_classes: ["UntappdCacheDO"]`); it applies on the next deploy with
> no action needed. After deploying, call `untappd_healthcheck` from claude.ai
> and confirm it reports the expected `tool_count` (the cache tools included) and
> `server_version` — that's how you verify the live build exposes them.

Before deploying to production, you can sanity-check the Worker locally with:

```sh
npm run worker:dev
```

and run the Worker-specific test suite with:

```sh
npm run worker:test
```

### 5. Add it as a connector in claude.ai

1. Go to claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Paste the deployed URL with `/mcp` appended:
   `https://untappd-connector.<your-subdomain>.workers.dev/mcp`
3. Claude will open the connector's login page (served by the Worker) and
   prompt for an **Untappd username or email** and **Untappd password**.
   Complete that login — this is the individual user's own Untappd account,
   not the operator's app credentials from step 3.

This connector is unlisted: it only shows up for people you've explicitly
shared the URL with, not in any public directory. Anyone with the URL who
completes their own Untappd login can use it under their own account.

### 6. Verify on the mobile Claude app

Connectors added on claude.ai sync to all clients for that account, including
the **mobile Claude app**. On mobile:

1. Confirm the connector appears (Settings → Connectors) and shows as
   connected.
2. Run a read, e.g. ask Claude to use `untappd_search_beer` for something
   common (e.g. "Fat Tire").
3. Run a dry-run write to confirm write tools are wired up without actually
   posting anything — e.g. ask for `untappd_toast` or `untappd_checkin`
   without `confirm: true`; every write tool in this server returns a preview
   instead of executing unless called with `confirm: true`.

If both work, the deploy is verified end-to-end.

## How auth works

- The **operator** (you) supplies the Untappd mobile-app `client_id` /
  `client_secret` once, as Worker secrets (step 3). These identify the app to
  Untappd's API and are shared across all users of this connector instance.
- Each **user** who adds the connector logs in with their *own* Untappd
  username and password, via the login page the Worker serves at
  `/authorize`.
- That password is used exactly once, to perform the same xauth login the
  local stdio server does (`POST https://api.untappd.com/v4/xauth`), and is
  never stored anywhere. Only the resulting **access token** (plus the
  username) is kept — encrypted, in the OAuth provider's KV-backed "props" —
  and used to make API calls on that user's behalf.

## Rotation / teardown

Rotate a secret (e.g. if the app credentials are compromised or reissued):

```sh
npx wrangler secret put UNTAPPD_CLIENT_ID
npx wrangler secret put UNTAPPD_CLIENT_SECRET
```

(`secret put` overwrites the existing value — no separate delete step is
needed to rotate.)

Remove a secret entirely:

```sh
npx wrangler secret delete UNTAPPD_CLIENT_ID
npx wrangler secret delete UNTAPPD_CLIENT_SECRET
```

Tear down the whole connector:

```sh
npx wrangler kv namespace delete --namespace-id <id-from-step-2>
```

then delete the Worker itself from the Cloudflare dashboard (Workers &
Pages → `untappd-connector` → Settings → Delete), or via:

```sh
npx wrangler delete
```

Deleting the KV namespace invalidates every stored user session — everyone
who'd added the connector will need to log in again if it's redeployed.
