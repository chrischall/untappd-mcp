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
calls the v4 API. This server reproduces that exactly:

- Reads carry the token as an `access_token` query param.
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
| `UNTAPPD_CLIENT_ID` | yes | The Untappd mobile app client id (see below). |
| `UNTAPPD_CLIENT_SECRET` | yes | The Untappd mobile app client secret. |
| `UNTAPPD_DEVICE_ID` | no | Stable device UUID the token is keyed to (a default is provided). |
| `UNTAPPD_UTV` | no | API version param (default `4.0.0`). |
| `UNTAPPD_USER_AGENT` | no | Override the User-Agent (default mimics the app). |
| `UNTAPPD_CACHE_DB` | no | Path to the local check-in cache SQLite file (default `~/.untappd-mcp/checkins.db`). Local/stdio only. |

Copy `.env.example` to `.env` and fill it in for local use.

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

Writes (confirm-gated — return a dry-run preview unless called with
`confirm: true`): `untappd_toast`, `untappd_add_comment`, `untappd_delete_comment`, `untappd_checkin`,
`untappd_wishlist_add`, `untappd_wishlist_remove`, `untappd_delete_checkin`,
`untappd_add_friend`, `untappd_accept_friend`, `untappd_reject_friend`, `untappd_remove_friend`.

Check-in cache: `untappd_sync_checkins`, `untappd_sync_user_beers`,
`untappd_cache_has_had`, `untappd_cache_has_had_many`, `untappd_cache_not_had`,
`untappd_cache_query`, `untappd_top_not_had`.

## Check-in cache

The Untappd API only exposes paged lists (50 per page) and has **no** "has this
user ever had beer X?" lookup — answering that from the API alone means paging an
entire history (often 11k+ check-ins) against a tight ~100-calls/hour rate limit.
These tools maintain a SQLite mirror so the question is answered instantly,
offline, with zero API calls. The mirror is a local file
(`node:sqlite`, path via `UNTAPPD_CACHE_DB`); the store is injectable, so another
deployment can back it differently without the tools changing.

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
