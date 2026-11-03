# untappd-mcp

MCP server for [Untappd](https://untappd.com) that talks to Untappd's **private
mobile (v4) API** as the user's own account — search, profiles, check-ins,
wishlists, badges, friends, feed, plus confirmation-gated writes (check-in, toast,
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
reproduces that byte-for-byte, with one deliberate difference:

- **Reads** carry the token as `Authorization: Bearer`, never in the URL. The
  app puts it in an `access_token` query param, but the API accepts the header
  (live-verified 2026-10-09), and URLs end up in proxy and server logs.
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

Core tables and two independent has-had sources:

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
- **`syncUserBeers` completion is count-verified, not "offset reached total".**
  Offset paging across runs is not a snapshot, so a resumed run re-reads the
  last `RESUME_OVERLAP` items (beers dropping out shift the list up), and
  reaching the end only counts as complete if the cache holds `total_count`
  beers. A NEW shortfall (bigger than `beers_accepted_gap`, the gap a previous
  full pass proved can't close) starts a rescan from the top that stops as soon
  as the gap closes (`beers_rescan_target`). This also self-heals caches marked
  complete before the check existed.
- Every cache READ returns a `freshness` block reporting each source's
  completeness **separately** plus a `caveat`, so a "not had" can be flagged as a
  possible false negative. New cache read tools must include it.
- Usernames are keyed **lowercased**; other stored fields keep their original casing.
- The cache holds OTHER users' dated venue history: `CheckinCache.open()` creates the dir `0700` and the db `0600` before SQLite opens it (and tightens old loose files). Retention is user-driven — `untappd_cache_forget` (confirm-gated, local-only) is the delete path; there is no TTL.
- **v4 tables** (added for venue history / favorites): `venues`
  (global), `user_venues`, `list_sync_state` (per user+list offset cursor), `brewery_beer_lists` +
  `brewery_beers` (TTL'd; never store brewery/beer_list's `have_had`, which is the AUTHENTICATED
  account's), `response_cache` (short-TTL raw responses), `wishlist`, `favorites` (manual, local only),
  `venue_drinks`, `api_calls`; v5 adds `brewery_likes`. Per-user tables are listed in `PER_USER_TABLES`, which drives
  `forgetUser` — add any new per-user table there.
- **Schema is versioned** (`PRAGMA user_version`, `SCHEMA_VERSION` in `store.ts`). A change goes in
  `VERSIONED_MIGRATIONS` with the next number and must be ADDITIVE: never drop/rewrite rows, since
  refilling a cache costs hours of rate-limited calls. A file newer than the build is used as-is.
  Migration runs in one write transaction that re-reads the version, so concurrent opens are safe.
- **Two processes can share the file**: `db.ts` sets `busy_timeout` + WAL and the driver uses
  `BEGIN IMMEDIATE` (a deferred read→write upgrade hits SQLITE_BUSY, which busy_timeout won't retry).
  `setState` is read-merge-write inside one transaction; net-new counts are taken inside the upsert's.
  `tests/cache-persistence.test.ts` proves it against the built bundle — it fails with "database is
  locked" if either pragma goes.
- **The cache path never depends on cwd**: relative/`~` overrides resolve against HOME, and
  `index.ts` logs the resolved path at startup.
- **Incremental `user/beers` refresh stops at the first cached beer whose `last_had` AND `had_count`
  are unchanged** — not merely "already cached": a re-had beer moves to the top, and a new beer can
  sit below it.
- **Venue history (`sync-venues.ts`)**: `user/venues` pages a NON-self user's full history but serves
  at most **25 per page even when asked for 50** — advance by the returned `pagination.offset` (else
  offset + items), and never treat a 25-item page as the short final page (end = empty page, or offset
  reaching `total_count`). Cursor/total live in `list_sync_state` (list `venues`), persisted every page;
  a resumed backfill re-reads `VENUES_RESUME_OVERLAP`. Once complete, a re-run pages sort=date from 0 and
  stops at the first page where EVERY venue's `recent_visit` and `total_count` are unchanged. A refresh
  cut short before that page (max_pages, rate guard, 429) keeps its own cursor in list `venues_refresh`
  and the next run RESUMES it — restarting at 0 would hit the already-upserted pages, read them as
  unchanged and stop above the remaining changes. Coverage reads as incomplete until it finishes.
  `findVisitedVenues` matches name loosely (literal substring OR every significant word whole) because
  a brewery_id is not its taproom's venue_id and Untappd keeps "… (duplicate of …)" venues.
- **Brewery beer lists (`brewery-beers.ts`)** are a per-brewery snapshot with a 7-day TTL clock
  (`brewery_beer_lists.fetched_at` = when the snapshot STARTED; appended pages don't reset it). A
  stale list or `refresh: true` restarts it (old rows deleted, so retired beers don't linger).
  `ranked_count` is the contiguous prefix of Untappd's default popularity order; the default sort is
  served from that prefix, any other sort only once the WHOLE list is cached (sorting a top-50 subset
  by name would be a different answer). beer_list's `has_had`/`total_user_count` are the
  AUTHENTICATED account's — `mapBreweryBeerItem` drops them and the cached tool output never shows them.
- **`response_cache`** (`response-cache.ts`, 6-hour TTL) serves `untappd_venue_menu` (keyed by venue +
  every paging param) and `untappd_venue_activity` (the RAW response, keyed by venue + limit + max_id,
  so either `view` is served from one entry). A thrown fetch is never cached; writes prune rows older
  than `RESPONSE_CACHE_RETENTION_MS` (48 h) because activity holds other people's check-ins. The
  brewery/venue tools take the cache as an OPTIONAL provider (`optionalCache`): if it can't open they
  just call Untappd.
- **Wishlist mirror (`sync-wishlist.ts`)**: every sync is a full pass from offset 0 (resumable, cursor
  in list `wishlist`). Rows are stamped with the pass's stamp (list `wishlist_pass`.last_synced_at,
  strictly later than the previous pass's), and only a FINISHED pass deletes rows with another stamp —
  a partial pass never removes anything.
- **Group has-had (`multi-user.ts`)**: `cache_has_had_many` / `top_not_had` take `usernames[]` +
  `mode` (`none_had` = nobody had it, `any_not_had` = someone hasn't). One `hasHadMany` per user;
  the single-user path keeps its old output shape. Passing `username` AND `usernames` is rejected.
- **Venue drinks (`venue-drinks.ts`, opt-in)**: `checkin/view` of each `user_venues` row's first/recent
  check-in, one call each under `max_calls` + the rate guard. Only beer/brewery/date are stored (never
  comments). A 404 is stored as a tombstone (bid AND beer_name null) so it is never re-asked;
  other errors stay pending. `getVenueDrinks` hides tombstones.
- **Favorites (`favorites.ts`)**: derived favorites are COMPUTED on read from the cache (thresholds in
  `DEFAULT_FAVORITE_THRESHOLDS`, each overridable), never stored, so they track the latest sync; manual
  ones live in the `favorites` table (local only). `listFavorites` / `favoriteLookup` merge per
  (kind, id) so an item appears ONCE with ordered, de-duplicated `sources`. Every `favorite` field is
  built by `favoriteLookup` — reuse it (trip_check too). Annotations are applied AFTER the response
  cache (venue_menu), never stored in it. The venue months rule only knows first/recent visit, so it
  also needs total_count ≥ the month threshold (2 visits can't cover 3 distinct months). The
  `untappd` source is the synced `brewery_likes` (breweries only — Untappd has no venue follow).
- **Brewery likes (`sync-brewery-likes.ts`, schema v5 `brewery_likes`)**: `user/brewerylikes/{user}`
  (the app's "followings"; works for non-self, total = user/info `stats.total_followings`). Honours
  limit=50; advance by the returned `pagination.offset`, which is ABSENT on an empty list. Same
  full-pass/stamp/prune-only-when-finished scheme as the wishlist (lists `brewery_likes` +
  `brewery_likes_pass`). `brewery/info`'s `claimed_status.follow_status` is the AUTHENTICATED
  account's — never report it for another user (same rule as beer_list's `have_had`).
- **Trip check (`src/tools/trip.ts`)**: `untappd_trip_check` answers visits/has-had from the cache only;
  its ONLY API calls are `brewery/beer_list` (via `getBreweryBeers`, so they land in the 7-day list
  cache) for a missing/stale list, under `api_budget` + `checkRateBudget`. A brewery stop with no
  venue_id/name/lat is visit-matched by the brewery's name (cached list, else the user's distinct beers).
  The near-a-favorite hint needs coordinates from the global `venues` table (`getVenues`), so a manual
  favorite venue nobody has synced is never hinted.
- **Batch, don't loop.** Use `hasHadMany(username, bids)` (two grouped queries per 500-bid chunk)
  for any list; `hasHad` per bid costs ~4 queries each. `tests/cache-batch.test.ts` pins the two
  to identical verdicts — change both or neither. Upsert "net new" counts look up only the batch's
  ids; don't go back to COUNT(*) before/after (quadratic over a backfill).
- `NodeSqlDriver` caches prepared statements by SQL text (bounded, cleared when full).
- `escapeLike` backslash-escapes `%`/`_`/`\` in user input and every LIKE goes through `LIKE_MATCH` (`ESCAPE '\'`), so a name like `100% Brewing` matches literally. The rated sorts put unrated (NULL) check-ins last.

## Menu picks (`src/menu/`)

`untappd_menu_pick` / `untappd_venue_pick` (`src/tools/menu.ts`) run one pipeline (`pick.ts`):
sync → resolve lines → has-had check → rank, all under ONE per-call `api_budget` (default 60).
The sync gets what's left after reserving ~3 calls per uncached line, never less than 1 page.

- Untappd beer search ANDs every term (live: "i believe in nashville blonde" → 0 hits), so
  `match.ts` tries the full line then a style-word-free fallback, and never maps `&` → "and".
- Scoring weights name tokens over brewery tokens, penalises beer-name tokens missing from the
  line (the Double/Triple Homestyle guard), adds log10(check-ins) so the canonical entry beats a
  3-check-in duplicate, and uses `venue_city` as a tie-breaker. The fixtures in
  `tests/fixtures/untappd-live.ts` are live captures; extend them rather than inventing payloads.
- Line→bid resolutions are cached in `item_resolutions` (global, not per user; key carries a
  version prefix — bump `RESOLUTION_KEY_VERSION` when scoring changes). Budget/429 failures are
  never cached.
- Ratings for not-had beers: when 2+ come from one brewery, one `brewery/beer_list` call (top 50
  by popularity, with ratings) replaces their `beer/info` calls; beers it misses fall back to
  `beer/info`. The whole list is seeded into `beer_meta`.
- `UntappdClient.quotaRemaining` is the rate-limit ESTIMATE from `src/ratelimit.ts` (null before
  this process has made a call in the hour), and `clampToQuota` (`src/quota.ts`) must keep treating
  null as "use the requested budget". See "Rate limit tracking" below.
- Search results carry NO rating. Don't seed `beer_meta` from them (that used to overwrite real
  ratings with null under a fresh timestamp); ratings come from `beer/info` or brewery/menu lists.

## Rate limit tracking (`src/ratelimit.ts`)

- **The v4 API sends `X-Ratelimit-Remaining: 0` on EVERY successful response** (live, 2026-11-02;
  404s carry no header). Taken at face value it clamped every budget to its floor. The estimate is
  therefore a LOCAL count of calls in the rolling hour against `UNTAPPD_RATE_LIMIT_PER_HOUR` (default
  100, else `X-Ratelimit-Limit` if ever sent); the Remaining header only counts once some response
  in the window reported it non-zero, or on a 429. A 429 blocks until its Retry-After / reset, else
  until the oldest call in the window ages out.
- Every response is recorded by `UntappdClient` (`rateLimit` tracker + `onApiCall` listeners).
  `index.ts` persists them into the cache's `api_calls` table (pruned to 2 h) once the cache is open,
  flushing what came before on open, so other processes sharing the file count them too. The merge is
  a multiset (max count per identical observation), so a process's own logged calls aren't counted twice.
- **`checkRateBudget` is the stop-before-429 guard**: syncs call it before EVERY call and stop with
  `stopped_for_rate_limit` + `rate_limit.resume_at` when the next call would leave fewer than
  `DEFAULT_RESERVE` (2). A `RateLimitError` mid-run is caught the same way — never thrown mid-batch.
  New paging syncs must use it; test fakes without a `rateLimit` tracker are treated as unconstrained.

## Environment (stdio)

```
UNTAPPD_ACCESS_TOKEN   optional  Pre-seeded access token — no password needed (mapped in manifest.json + .mcp.json too)
UNTAPPD_USERNAME       if no token  Untappd username or login email (also the default for user-scoped tools)
UNTAPPD_PASSWORD       if no token  Untappd password — used only for the xauth login
UNTAPPD_CLIENT_ID      login+writes  Mobile-app client id (capture via HTTPS proxy; see README); token-only reads work without it
UNTAPPD_CLIENT_SECRET  login+writes  Mobile-app client secret
UNTAPPD_DEVICE_ID      optional  Stable device UUID the token is keyed to
UNTAPPD_UTV            optional  API version param (default 4.0.0)
UNTAPPD_USER_AGENT     optional  Default mimics Untappd/4.7.13 (ios; iPadOS 26.5)
UNTAPPD_TIMEZONE       optional  IANA zone check-ins are stamped with when the call passes no `timezone` (default: process zone — UTC on a hosted connector)
UNTAPPD_PHOTO_DIR      optional  Allow-list dir(s) for untappd_checkin photo_path (default ~/Downloads/untappd-mcp — confined by default; bytes are always sniffed as JPEG/PNG, 15 MB cap)
UNTAPPD_CACHE_DB       optional  Cache SQLite path (default ~/.untappd-mcp/checkins.db, owner-only 0600). LOCAL ONLY
UNTAPPD_CACHE_DIR      optional  Cache directory instead of ~/.untappd-mcp (file is checkins.db); CACHE_DB wins
UNTAPPD_RATE_LIMIT_PER_HOUR optional  Hourly limit the sync guard enforces (default 100)
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
- **Writes are confirmation-gated** through `confirmWrite` (`src/tools/confirm.ts`,
  mcp-utils' `requireConfirmationWithFallback` + `confirmationFromEnv`): a
  prompt where the client supports one (unless `MCP_CONFIRM_ELICITATION=off`), else a phase-1 preview + `confirmToken`
  that makes **no network call**, and a phase-2 call with that token. `payload`
  must be exactly what the write sends (it is hashed into the token) and is
  rebuilt from the args on every call. Keep new writes to that shape; the input
  is `confirmToken: confirmTokenParam`, never a `confirm` boolean.
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
