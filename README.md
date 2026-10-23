# untappd-mcp

An MCP server for [Untappd](https://untappd.com). It talks to Untappd's mobile
(v4) API using your own account — search beers, breweries, and venues; read
profiles, check-ins, wishlists, distinct beers, badges, friends, and your friend
activity feed; and post check-ins, toasts, and comments.

> Developed and maintained by AI (Claude Code). Use at your own discretion. This
> is an unofficial client that uses Untappd's private mobile API; it is not
> affiliated with or endorsed by Untappd.

## How it works

Untappd's iPad/iPhone app authenticates with a username/password **xauth** login
(`POST https://api.untappd.com/v4/xauth`) that returns an access token, then
calls the v4 API. This server reproduces that, except where the token goes:

- Reads carry the token as an `Authorization: Bearer` header, never in the URL
  (the app uses an `access_token` query param; the API accepts both).
- Writes carry it as an `Authorization: Bearer` header (with the app's client
  credentials in the query), matching the app's real requests.

The token is fetched on demand, cached in memory, and refreshed automatically if
it goes stale.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `UNTAPPD_ACCESS_TOKEN` | no | An access token you already hold. Supply this and **no password is needed** — the xauth login is skipped entirely. |
| `UNTAPPD_USERNAME` | if no token | Your Untappd username or login email. |
| `UNTAPPD_PASSWORD` | if no token | Your Untappd password (used only for the xauth login that mints a token). |
| `UNTAPPD_CLIENT_ID` | for login & writes | The Untappd mobile app client id (see below). A pre-seeded access token can read without it. |
| `UNTAPPD_CLIENT_SECRET` | for login & writes | The Untappd mobile app client secret. |
| `UNTAPPD_DEVICE_ID` | no | Stable device UUID the token is keyed to (a default is provided). |
| `UNTAPPD_UTV` | no | API version param (default `4.0.0`). |
| `UNTAPPD_USER_AGENT` | no | Override the User-Agent (default mimics the app). |
| `UNTAPPD_TIMEZONE` | no | IANA timezone (e.g. `America/New_York`) that check-ins are stamped with when the call doesn't pass `timezone`. Set it when the server runs somewhere other than the drinker's zone (e.g. a hosted connector, usually UTC). Defaults to the server process's zone. |
| `UNTAPPD_PHOTO_DIR` | no | The directory `untappd_checkin`'s `photo_path` must be inside (several allowed, separated by `:`). Defaults to `~/Downloads/untappd-mcp` — put a photo there to attach it. Any other file is refused, so a prompt-injected shout or comment can't publish an arbitrary image from your disk. |
| `UNTAPPD_CACHE_DB` | no | Path to the local check-in cache SQLite file (default `~/.untappd-mcp/checkins.db`). A relative path or leading `~` resolves against your **home** directory, never the working directory, so every host (Claude Desktop, Claude Code, …) finds the same file; the resolved path is logged to stderr at startup. The db file is always made owner-only (`0600`), and so are any directories the server creates plus the default `~/.untappd-mcp`; a directory you point this into that already exists keeps its permissions. Local/stdio only. |
| `UNTAPPD_CACHE_DIR` | no | Directory for the cache instead of `~/.untappd-mcp` (the file is `checkins.db` inside it). `UNTAPPD_CACHE_DB` wins if both are set. |

Copy `.env.example` to `.env` and fill it in for local use.

### Confirmations

Every write asks you to confirm it first. A client that can show a confirmation
prompt (Claude Code) shows one (unless `MCP_CONFIRM_ELICITATION=off`). Elsewhere the write takes two calls: the first
does nothing and returns a preview of the exact request plus a `confirmToken`,
and only a repeat call with the same arguments and that token performs it. A
token works once, for that tool and those arguments only; change anything and
the call is refused with a fresh preview.

| variable | default | |
|---|---|---|
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt (claude.ai, Claude Desktop). `ask-user`: two steps — the first call does nothing and returns a preview plus a token, and the model must get your approval in chat before calling again with it. `auto`: the same two steps, but the model may use the token after reviewing the preview itself. `refuse`: writes are refused on such clients. A client that can show prompts (Claude Code) always gets the real prompt, unless `MCP_CONFIRM_ELICITATION=off`. An unrecognised value is treated as `refuse`. |
| `MCP_CONFIRM_ELICITATION` | `on` | `off` never shows a confirmation prompt, so every client gets the `MCP_CONFIRM_MODE` behaviour. Set it for a client that says it can show prompts but never does (the write hangs — opencode 2.0.x). Any other value is treated as `on`, with a warning on stderr. |
| `MCP_CONFIRM_TTL_SECONDS` | `600` | How long a token stays valid. |
| `MCP_CONFIRM_SECRET` | random per process | Signing key; set it only if tokens must survive a server restart. |

### Obtaining the client id / secret

Untappd does not publish these; they live in the mobile app. Capture them from
your own app's traffic with an HTTPS proxy:

1. Install a proxy such as [mitmproxy](https://mitmproxy.org) and trust its CA
   certificate on the device running the Untappd app.
2. Point the device (or, on an Apple-silicon Mac running the iPad app, the Mac's
   system HTTP/HTTPS proxy) at the proxy.
3. Open Untappd and sign in. Find the `POST https://api.untappd.com/v4/xauth`
   request — its **query string** contains `client_id` and `client_secret`.
4. Put those into `UNTAPPD_CLIENT_ID` / `UNTAPPD_CLIENT_SECRET`.

Keep these values private; do not commit them.

## Tools

Reads: `untappd_search_beer`, `untappd_beer_info`, `untappd_beer_activity`,
`untappd_search_brewery`, `untappd_brewery_info`, `untappd_brewery_beers`,
`untappd_search_venue`, `untappd_venue_info`, `untappd_venue_activity`,
`untappd_user_info`, `untappd_user_checkins`, `untappd_user_wishlist`,
`untappd_user_beers`, `untappd_user_badges`, `untappd_user_friends`, `untappd_pending_friends`,
`untappd_activity_feed`, `untappd_checkin_info`, `untappd_resolve`, `untappd_open_url`, `untappd_user_venues`, `untappd_venue_by_foursquare`, `untappd_trending`,
`untappd_notifications`, `untappd_local_checkins`, `untappd_healthcheck`.

Writes (each asks you to confirm first — see [Confirmations](#confirmations)): `untappd_toast`, `untappd_add_comment`, `untappd_delete_comment`, `untappd_checkin`,
`untappd_wishlist_add`, `untappd_wishlist_remove`, `untappd_delete_checkin`,
`untappd_add_friend`, `untappd_accept_friend`, `untappd_reject_friend`, `untappd_remove_friend`.

Check-in cache: `untappd_sync_checkins`, `untappd_sync_user_beers`,
`untappd_cache_has_had`, `untappd_cache_has_had_many`, `untappd_cache_not_had`,
`untappd_cache_query`, `untappd_top_not_had`, `untappd_cache_status`, `untappd_cache_forget`.

Menu picks: `untappd_menu_pick` (tap-list lines in, ranked not-had beers out),
`untappd_venue_pick` (same, from a venue's Untappd menu).

## Picking a beer off a menu

`untappd_menu_pick` turns "find Mer a beer" from a menu photo into one call.
Give it the lines as read off the board:

```json
{
  "username": "mer",
  "items": [
    "HAP & HARRY'S TENNESSEE LAGER $6",
    "I BELIEVE IN NASHVILLE BLONDE",
    "JACKALOPE FENNARIO IPA",
    "BEARDED IRIS HOMESTYLE",
    "BLACK ABBEY SEASONAL",
    "ROTATING CIDER"
  ],
  "venue_city": "Nashville",
  "top_n": 2
}
```

In one call it:

1. **Freshens the cache.** If the user's distinct-beers list is already complete
   it does an incremental refresh, stopping at the first beer that's cached and
   unchanged (usually one page). If the list is empty or partial it backfills
   in the same call until done or `api_budget` (default 60 calls, shared by
   every step) runs out. You never need to call a sync tool first.
2. **Resolves each line to a beer.** It strips prices, sizes, ABV and
   punctuation, searches Untappd (falling back to a query without the style
   word, because Untappd search matches every term), and scores the candidates
   on brewery match, beer-name match (so "Homestyle" isn't read as "Double
   Homestyle"), check-in volume (the canonical entry wins over a 3-check-in
   duplicate) and `venue_city`. Up to 4 searches run at once, and a 429 is
   retried with backoff. Resolutions are cached on disk, so the next visit to
   the same venue costs no searches.
3. **Handles generic lines.** `<Brewery> SEASONAL` / `ROTATING` becomes a
   `possible` list of that brewery's seasonal-looking beers, marked
   `needs_confirmation`. A line with no brewery (`ROTATING CIDER`) comes back
   `unresolved: "ask bartender"`.
4. **Checks every beer against the cache** (both sources, as `has_had_many` does).
5. **Ranks the not-had beers** by global rating, applies `style_filter`, and
   returns the top `top_n` as `picks`.

Output for the call above, with Mer having had Fennario (abridged: `not_had`
also lists the Tennessee Lager at 3.33, `possible` lists six candidates, and a
`freshness` block is appended):

```json
{
  "picks": [
    { "item": "BEARDED IRIS HOMESTYLE", "bid": 1502190, "name": "Homestyle", "brewery": "Bearded Iris Brewing",
      "style": "IPA - New England / Hazy", "abv": 6, "global_rating": 3.98,
      "reason": "not had · 3.98 global rating · #1 of 3 not-had beers on this list" },
    { "item": "I BELIEVE IN NASHVILLE BLONDE", "bid": 3780741, "name": "I Believe In Nashville",
      "brewery": "I Believe Brewing Company", "style": "Blonde / Golden Ale - American", "abv": 4.5,
      "global_rating": 3.54, "reason": "not had · 3.54 global rating · #2 of 3 not-had beers on this list" }
  ],
  "had": [
    { "item": "JACKALOPE FENNARIO IPA", "bid": 1893601, "name": "Fennario", "brewery": "Jackalope Brewing Company",
      "count": 3, "last_date": "2025-08-01T20:00:00.000Z", "user_rating": 3.75 }
  ],
  "possible": [
    { "item": "BLACK ABBEY SEASONAL", "brewery": "The Black Abbey Brewing Company",
      "reason": "seasonal-looking beers from this brewery",
      "candidates": [
        { "bid": 1223176, "name": "Chronicles Festbier", "style": "Festbier", "abv": 4.9, "global_rating": 3.672, "had": false }
      ],
      "needs_confirmation": true }
  ],
  "unresolved": [{ "item": "ROTATING CIDER", "reason": "ask bartender" }],
  "sync": { "mode": "backfill", "api_calls": 1 },
  "api_calls": 11,
  "api_budget": 60,
  "another_run_needed": false
}
```

`sync` says what the refresh did; coverage lives in `freshness`. If the budget
runs out before the backfill finishes, `freshness.coverage_complete` is `false`,
`another_run_needed` is `true`, and the `freshness` caveat warns that a "not
had" may be a false negative. Calling again continues from where it stopped.

**Quota.** When an Untappd response carries `X-Ratelimit-Remaining`, the server
remembers it for the hour, and every budgeted tool (`menu_pick`, `venue_pick`,
`top_not_had`, both syncs) caps its budget to what's left. The result then
includes `quota_remaining`, plus `budget_clamped_to_quota: true` when the cap
applied. Untappd's public API documents the header; if the private API this
server uses doesn't send it, budgets work exactly as before.

`untappd_venue_pick` takes an Untappd venue URL (`https://untappd.com/v/<slug>/<id>`)
or id instead of `items`. It pages through the venue's whole verified menu, takes
the venue's city from it, and runs the same check and ranking. Menu items already
carry beer ids, so there is no search step.

## Check-in cache

The Untappd API only exposes paged lists (50 per page) and has **no** "has this
user ever had beer X?" lookup — answering that from the API alone means paging an
entire history (often 11k+ check-ins) against a tight ~100-calls/hour rate limit.
These tools maintain a SQLite mirror so the question is answered instantly,
offline, with zero API calls. The mirror is a local SQLite file
(`node:sqlite`, default `~/.untappd-mcp/checkins.db`, overridable with
`UNTAPPD_CACHE_DB` / `UNTAPPD_CACHE_DIR`). The store is injectable, so another
deployment can back it differently without the tools changing.

**Persistence.** The file survives restarts, and a backfill that was cut off
(rate limit, crash, host quit) resumes from its saved offset on the next sync.
The file runs in WAL mode with a busy timeout and does every write in a
transaction, so two hosts open at the same time can share it. The schema is
versioned (`PRAGMA user_version`) and only ever migrated forward, adding
columns and tables, so an upgrade never wipes it. `untappd_cache_status` shows
the resolved path, size, schema version and per-user coverage.

Two sync sources fill the cache:

- **`untappd_sync_user_beers`** pages `user/beers` — the user's **complete
  distinct-beers list** (thousands of rows, not tens of thousands of check-ins).
  This is the **cheapest way to get full "has had" coverage** and, unlike
  `user/checkins`, it pages fully for any public/friend account. **Start here**
  for has-had questions.
- **`untappd_sync_checkins`** pages `user/checkins` for detailed check-ins
  (venue, date, comment). Only your **own** account pages fully — Untappd returns
  just the ~50 most recent for anyone else and won't page further, which the tool
  reports as `history_truncated` (it never falsely claims `backfill_complete`).
  Pass `force_backfill: true` to reset a cache wrongly marked complete and
  re-page from newest (cached rows are kept). Use this for recent venue/date
  detail; use `untappd_sync_user_beers` for coverage.

Both are resumable: they fetch `max_pages` per call (default 10), persist
progress after every page, and set `another_run_needed: true` until done — just
call again until it's `false`.

**Query** the cache with no further API calls. The has-had tools consult **both**
sources (a hit in either counts as had):

- `untappd_cache_has_had` — has the user had a beer, by exact `bid` or a
  case-insensitive `beer_name` substring; returns count, best rating, last date,
  matching sources, and any detailed check-ins.
- `untappd_cache_has_had_many` — cross-check a whole list of `bids` in one call
  (e.g. a venue's menu) → had/not-had per beer.
- `untappd_cache_not_had` — given a list of `bids`, return just the ones the user
  has **not** had — the "what's new to me on this menu?" filter.
- `untappd_top_not_had` — from a list of `bids`, return the **top N not-had
  beers ranked by Untappd global rating**, with an optional `style` filter (the
  "what should I order off this tap list?" tool). Not-had filtering is
  cache-only; beer ratings come from a metadata cache (`beer_meta`) that's seeded
  opportunistically by `untappd_beer_info` / `untappd_search_beer` and topped up
  via `beer/info` only on a cache miss or entries older than 30 days — capped at
  `api_budget` calls/run (default 25), returning `partial: true` /
  `another_run_needed: true` when more are needed.
- `untappd_cache_query` — filter cached **check-ins** by brewery, style,
  `min_rating`, venue, and/or date range, with sorting and a limit.

Every read result carries a `freshness` block that reports **each source's
completeness separately** (`checkins.backfill_complete` / `history_truncated`,
`beers.complete`, per-source percentages) plus `coverage_complete`, and a
`caveat` while coverage is incomplete — so a "not found" can be flagged as
possibly a false negative until the relevant sync finishes.

Syncing **another** user goes through the same authed endpoint as
`untappd_user_checkins`, so Untappd's privacy rules apply: it only works if that
account is public or your friend. Otherwise the sync returns a clear error
telling you to add them as a friend first.

**Retention.** Nothing in the cache expires: synced rows — including another
user's dated check-ins, comments and venues — stay until you remove them. The
file is created owner-only (directory `0700`, database `0600`, and older
installs are tightened on open). `untappd_cache_forget` deletes one user's
cached check-ins, distinct-beers list and sync state after a confirmation
(preview shows the username and row counts); it touches only the local cache,
never Untappd, and a later sync can re-fetch. Deleting the file removes
everything.

A cache holds only the check-ins the account it belongs to was allowed to
fetch. `untappd_healthcheck` reports the running version and the exact tool set
(count + names + a stable hash), so you can confirm which build is serving.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
