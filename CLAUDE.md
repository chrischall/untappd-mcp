# untappd-mcp

MCP server for [Untappd](https://untappd.com) that talks to Untappd's **private
mobile (v4) API** as the user's own account — search, profiles, check-ins,
wishlists, badges, friends, feed, plus confirm-gated writes (check-in, toast,
comment, friend actions). There is no public/official API here: every endpoint
and payload shape in this repo was reverse-engineered from the iPad app's
traffic, so treat undocumented field names as observations, not contracts.

**One entry point:** `src/index.ts` (stdio, the npm/mcpb package).

## Commands

```bash
npm run build        # tsc → dist/, then esbuild bundle → dist/bundle.js
npm test             # vitest run
```

There is **no coverage threshold** in `vitest.config.ts` (reporters only) —
unlike several sibling MCPs, a coverage drop will not fail CI here.

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
- **A pre-seeded token is one-way, and the 401 says so.** A deployment
  configured with a token (`UNTAPPD_ACCESS_TOKEN`, or the `token` option) but
  **no username/password** cannot use the client's 401 → drop-token → re-login
  path: there is nothing to log in with. It used to fall through to
  `missingCredsError()` and tell the operator to set the very variable they had
  set. `request()` now checks `tokenIsSupplied` before dropping the token and
  raises "the token has expired or been revoked" instead — naming the real
  event, and skipping a retry that had nothing to retry with. `tokenIsSupplied`
  is cleared by `login()`, because a token this client MINTED can simply be
  re-minted. Keep those two cases distinct if you touch the 401 branch, and
  don't answer a stale token by adding stored passwords.

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
  the slim projections, reached through the fleet `view` parameter and applied
  **by default** (`view: 'full'` is the way back to the whole record); each one
  degrades safely — if `<container>.items` isn't where expected it warns to
  stderr and returns the RAW response rather than an empty projection.
- **`view` never leaves this process.** It names a response shape and Untappd
  has never heard of it. Four `*/info` endpoints take their *own* `compact=true`
  (it drops the embedded activity/list blocks server side), and that is the one
  place a rung reaches upstream — through `upstreamCompact()`, which yields
  Untappd's spelling, never ours. Destructure `view` out of a handler's
  arguments; never hand the whole argument object to `client.get`.
  `tests/tools/read.test.ts` asserts this on every view-taking tool.
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
queries back any engine: `node:sqlite` is the one that ships (`db.ts`).
`store.ts` imports nothing platform-specific — keep it that way, so a different
deployment can back the same schema with a different driver.

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
bump doesn't need a code change. Where credentials arrive through
`ClientOptions` instead, these env fallbacks are inert.

## Gotchas

- **ESM + NodeNext**: relative imports need `.js` extensions even from `.ts`.
- **stdio transport**: stdout is JSON-RPC only; all logging goes to stderr.
  `client.ts` guards its `.env` load on `import.meta.url` because in some
  runtimes it's undefined and there is no local `.env`.
- `VERSION` comes from `src/version.ts`, the single release-please marker;
  `tests/version-sync.test.ts` guards it.
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
ruleset requires the `ci-gated` context (not `ci / ci`).
