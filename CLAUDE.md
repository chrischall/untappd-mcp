# untappd-mcp

MCP server for [Untappd](https://untappd.com) that talks to Untappd's **private
mobile (v4) API** as the user's own account — search, profiles, check-ins,
wishlists, badges, friends, feed, plus confirm-gated writes (check-in, toast,
comment, friend actions). There is no public/official API here: every endpoint
and payload shape in this repo was reverse-engineered from the iPad app's
traffic, so treat undocumented field names as observations, not contracts.

**Dual-target.** The same tool registrars back two entry points:
`src/index.ts` (stdio, the npm/mcpb package) and `src/worker.ts` (a hosted
Cloudflare Worker "remote connector" for claude.ai, live at
`connector.untappd.nullnet.app`, built on `@chrischall/mcp-connector`).

## Commands

```bash
npm run build        # tsc → dist/, then esbuild bundle → dist/bundle.js
npm test             # vitest run — the NODE pool (12 files / 125 tests, 2026-07-19)
npm run worker:test  # vitest --config vitest.workers.config.ts — the WORKERS pool
npm run worker:dev   # wrangler dev
npm run worker:deploy # wrangler deploy — local path; CI also deploys on release (docs/DEPLOY-CONNECTOR.md)
```

Both suites pass on `main` as of 2026-07-19. There is **no coverage threshold**
in `vitest.config.ts` (reporters only) — unlike several sibling MCPs, a
coverage drop will not fail CI here.

## Auth / session model

Untappd's app does a username+password **xauth** POST
(`POST /v4/xauth?client_id=…&client_secret=…`, form body with `device_udid`,
`app_version`, `multi_account=true`) and gets back an access token. This repo
reproduces that byte-for-byte, including the app's split auth convention:

- **Reads** carry the token as an `access_token` **query param**.
- **Writes** carry it as `Authorization: Bearer` **plus** `client_id` /
  `client_secret` in the query. `UntappdClient.write()` attaches both centrally;
  every mutating tool routes through it.

The `client_id` / `client_secret` are the *mobile app's*, not per-user — you
capture them once with an HTTPS proxy (README). Four secrets total, and the
constructor **defers** the missing-credential error so the server still boots
and answers a host's install-time `tools/list` probe.

Two auth quirks worth knowing:

- **2FA accounts cannot log in.** xauth returns no token and sets
  `two_factor_enabled`; `xauthLogin` turns that into an explicit error. There is
  no second factor path.
- **On the Worker, tokens are one-way.** `buildClient` constructs the client with
  a *pre-seeded* token from the OAuth props and **no username/password** (by
  design — the connector's privacy note promises the password isn't stored). So
  the client's 401 → drop-token → re-login path cannot re-login: it falls through
  to `missingCredsError()` and the hosted user sees a confusing "Untappd
  credentials are not configured — missing …" message when what actually
  happened is *their token went
  stale and they must re-authorize the connector*. If you touch that path, fix
  the message for the connector case rather than adding stored passwords.

## Untappd v4 API quirks

- **~100 calls/hour rate limit** per token. This constrains the whole design:
  every paging tool takes a per-call page/API budget, persists progress, and
  returns `another_run_needed` rather than looping. Don't add a tool that walks
  an unbounded history in one call.
- **`user/checkins` only pages fully for your OWN account.** For anyone else
  Untappd returns roughly the 50 most recent and then *silently ignores*
  `max_id` — the cursor stops advancing instead of erroring. `sync.ts` detects
  this by checking `page.nextMaxId >= maxId` and reports `history_truncated`; it
  must never be read as progress.
- **`user/beers` pages fully for any public/friend account** and is offset-paged
  (`limit`/`offset`, `sort=date`). It is the cheap, complete route to "has this
  user had beer X" — thousands of distinct beers vs tens of thousands of
  check-ins. It is the *preferred* sync.
- No "has user X had beer Y" endpoint exists at all. That absence is the entire
  reason the local cache exists.
- **Fat, drifty payloads.** A check-in record is ~5 KB. `src/compact.ts` holds
  opt-in slim projections; each one degrades safely — if `<container>.items`
  isn't where expected it warns to stderr and returns the RAW response rather
  than an empty projection.
- Shape landmines seen live: `venue: []` when a check-in has no venue (hence
  `asDict` in `store.ts`), and rating fields that appear as
  `user_rating_score` *or* `user_auth_rating_score`.
- Errors can arrive as HTTP 200 with `meta.code >= 400`; `parseJson` checks both.
- `checkin/toast` is a **toggle** — calling it on an already-toasted check-in
  removes the toast. The tool description says so; keep it that way.
- Untappd URL shapes (`resolve.ts`): `/b/<slug>/<bid>`, `/w/…` brewery,
  `/v/…` venue, `/user/<name>[/checkin/<id>]`.

## Check-in cache

`src/cache/` is a SQLite mirror with **one copy of the SQL** (`store.ts`,
`CheckinStoreCore`) over a tiny synchronous `SqlDriver`, so the same schema and
queries back both engines: `node:sqlite` on stdio (`db.ts`) and Durable Object
SQLite on the connector (`durable.ts`). `store.ts` imports nothing
platform-specific — keep it that way or the connector breaks.

Three tables and two independent sources:

- `checkins` ← `user/checkins` — detailed (venue/date/comment), truncated for
  non-self accounts.
- `distinct_beers` ← `user/beers` — complete has-had coverage.
- `beer_meta` — global beer facts keyed by bid, **shared across usernames**
  (beer facts are the same for everyone), seeded opportunistically by
  `untappd_beer_info` / `untappd_search_beer` and re-fetched at most every 30 days.

Non-obvious behaviours that were each fixed the hard way:

- **has-had consults BOTH sources**; a hit in either counts. Counts prefer
  `user/beers`' authoritative `had_count` over the number of cached check-ins.
- **`backfill_complete` is coverage-derived, not "ran out of pages".** It's only
  set once the cache holds ~all of `stats.total_checkins`
  (`COVERAGE_THRESHOLD` 0.98 **or** within `COVERAGE_DRIFT_FLOOR` = 50 rows —
  the absolute floor exists so a small, genuinely complete history isn't
  re-paged forever). A cache wrongly marked complete **self-heals** on the next
  sync, or explicitly via `force_backfill: true` (which clears state but keeps
  rows).
- **`syncCheckins`' `maxPages` is a TOTAL budget shared by two phases**, not
  per-phase. Phase 1 (incremental catch-up) always costs at least one page just
  to reconfirm the top; with a single shared counter Phase 2 (backfill) could get
  ZERO pages forever, leaving a permanent gap that made `has_had` false-negative
  every bid inside it. Hence the ceil/remainder split, plus the
  `served_backfill_last` turn flag for the `max_pages: 1` tie where the split
  zeroes one phase. Don't "simplify" this back into one counter.
- Every cache READ returns a `freshness` block reporting each source's
  completeness **separately** plus a `caveat`, so a "not had" can be flagged as a
  possible false negative. New cache read tools must include it.
- Usernames are keyed **lowercased**; other stored fields keep their original casing.
- `escapeLike` replaces `%`/`_` in user input with a space (the LIKE patterns set no ESCAPE clause).

## Hosted connector (Cloudflare Worker)

`src/worker.ts` wires the same registrars into `@chrischall/mcp-connector`'s
OAuth + `McpAgent` harness. Two Durable Objects: `MCP_OBJECT` →
`UntappdMcpAgent` (the harness's per-session agent, ephemeral) and `CACHE_DO` →
`UntappdCacheDO` — a **separate, durable** cache keyed by
`idFromName(operatorUsername.toLowerCase())`, so one cache follows a user across
conversations and holds only check-ins *their* account was allowed to fetch.
Never key that DO by the subject being queried.

- **The env/username reach the cache registrar via a `WeakMap` keyed on the
  client instance**, set in `buildClient`, *not* through a registrar context
  argument. That's deliberate: a context arg depends on the connector build
  forwarding it, and a stale bundle silently dropping it is exactly what once
  made every cache tool throw `Cannot read properties of undefined (reading 'env')`.
- The provider is **deferred** (built per tool call) so a missing `CACHE_DO`
  binding surfaces as a clear error on a cache tool instead of breaking client
  construction and taking the API tools down with it.
- Connector deps (`@chrischall/mcp-connector`, `agents`,
  `@cloudflare/workers-oauth-provider`) are **devDependencies** — the Worker is
  bundled by wrangler and isn't part of the published npm package.
- `UNTAPPD_CLIENT_ID`/`_SECRET` are wrangler **secrets** (operator-level, shared
  by all connector users); each user supplies only their own username/password on
  the login page. `wrangler.jsonc` carries a real `OAUTH_KV` id — the deploy doc
  still describes it as a placeholder to fill in.
- `untappd_checkin`'s `photo_path` reads a **local** file, so photo attachment is
  effectively stdio-only: a hosted user's path doesn't exist on the Worker.
- `untappd_healthcheck` reports version + tool count + a stable FNV-1a hash of
  the sorted tool names. That's how you confirm which build a connector is
  actually serving (a stale deploy looks fine otherwise).
- Deploy is **automatic on release** — `release-please.yml`'s `deploy-connector`
  job calls the shared `chrischall/workflows` reusable deploy workflow, pinned to
  the release tag. `Actions → deploy-connector → Run workflow` deploys any ref on
  demand, and `npm run worker:deploy` still works locally.
  `docs/DEPLOY-CONNECTOR.md`.

## The two test pools (the constraint that bites)

Worker code imports `cloudflare:workers` and **cannot load in the node pool**.
The split is enforced in three places, and all three must agree:

1. `vitest.config.ts` `test.exclude`s `tests/worker.test.ts` and
   `tests/worker-cache.test.ts` (they import the virtual `cloudflare:test` module).
2. `vitest.workers.config.ts` `include`s exactly those two, running them in the
   real Workers runtime (Miniflare) against `wrangler.jsonc`'s bindings.
3. `tsconfig.json` `exclude`s `src/worker.ts`, `src/untappd-auth.ts`, and
   `src/cache/durable.ts`, so `tsc` never emits them into the published `dist/`.

**Worker-only modules must never be imported, even transitively, by any test the
node pool runs** — one such import fails the whole node suite at load time with
an unresolvable `cloudflare:workers`. When adding a
Worker-side test, add it to *both* config lists.

Two traps inside that:

- `src/untappd-auth.ts` **is** node-loadable (its only connector import is
  `import type`) and `tests/untappd-auth.test.ts` runs it in the node pool — but
  it's tsconfig-excluded, so **`tsc` never typechecks it**. A type error there
  surfaces only at `wrangler deploy`. Same for `src/cache/durable.ts`.
- CI historically ran **only** the node pool, so a connector regression could
  merge green. PR #78 (`fix(ci): run the Workers test pool in CI`) chains
  `npm run worker:test` onto `ci.yml`'s `test-command`; as of 2026-07-19 that PR
  is still **open**, so `main`'s `ci.yml` still says `test-command: npm test`.
  Until it lands, run `npm run worker:test` by hand before touching the Worker.

## Environment (stdio)

```
UNTAPPD_USERNAME       required  Untappd username or login email (also the default for user-scoped tools)
UNTAPPD_PASSWORD       required  Untappd password — used only for the xauth login
UNTAPPD_CLIENT_ID      required  Mobile-app client id (capture via HTTPS proxy; see README)
UNTAPPD_CLIENT_SECRET  required  Mobile-app client secret
UNTAPPD_DEVICE_ID      optional  Stable device UUID the token is keyed to
UNTAPPD_UTV            optional  API version param (default 4.0.0)
UNTAPPD_USER_AGENT     optional  Default mimics Untappd/4.7.13 (ios; iPadOS 26.5)
UNTAPPD_CACHE_DB       optional  Cache SQLite path (default ~/.untappd-mcp/checkins.db). LOCAL ONLY
```

The app-mimicking constants in `client.ts` (`appVersion`, device fields,
User-Agent) are **not secrets** — they're overridable so a future app-version
bump doesn't need a code change. On the Worker these env fallbacks are inert:
credentials arrive from the Cloudflare bindings via `ClientOptions`.

## Gotchas

- **ESM + NodeNext**: relative imports need `.js` extensions even from `.ts`.
- **stdio transport**: stdout is JSON-RPC only; all logging goes to stderr.
  `client.ts` guards its `.env` load on `import.meta.url` because in the Workers
  runtime it's undefined and there is no local `.env`.
- **Adding or renaming a registrar means editing BOTH `src/index.ts` and
  `src/worker.ts`** — they list the registrars independently. Nothing is carved
  out of the hosted build; the tool surfaces are meant to be identical.
- `src/worker.ts` must never import `src/index.ts` (shebang + top-level
  `await runMcp()`). Both import `VERSION` from `src/version.ts`, which is the
  single release-please marker; `tests/version-sync.test.ts` guards it.
- **Writes are confirm-gated**: without `confirm: true` a write tool returns a
  dry-run preview and makes **no network call**. Keep new writes to that shape.
- `untappd_checkin` opens the photo blob *before* POSTing the check-in (so a bad
  path can't orphan a photo-less check-in), and a failed S3 photo upload is
  surfaced as `photo_error` rather than thrown — the check-in already exists.
- **AI-maintained**: the README says so and `src/index.ts` prints the same
  notice to stderr at startup.

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

Repo-specific: `ci.yml` runs in **status-gate mode** — an un-armed PR is blocked
by a yellow `ci-gated: pending` commit status rather than a red job, and the
ruleset requires the `ci-gated` context (not `ci / ci`). Deploying the Worker
connector **is** part of a release: alongside the `mcp-publish` hand-off for the
package artifacts, `release-please.yml`'s `deploy-connector` job calls
`chrischall/workflows`' reusable connector-deploy workflow at the release tag. It
is deliberately not gated on `publish`, so a registry hiccup will not leave the
connector stale; `Actions → deploy-connector → Run workflow` redeploys any ref on
demand if the release deploy fails.
