---
name: untappd-mcp
description: Search Untappd beers, breweries, and venues; read user profiles, check-ins, wishlists, distinct beers, badges, friends, and your friend activity feed; and post check-ins, toasts, and comments to your own Untappd account. Use when the user asks about beer ratings, what a beer or brewery is like on Untappd, someone's Untappd check-ins or wishlist, or wants to log/toast/comment on a beer.
---

# Untappd MCP

Talks to Untappd's mobile (v4) API using your own account. Logs in via the app's
`xauth` endpoint (username + password → access token) and calls the same
endpoints the iPad app uses.

## Setup

Set four environment variables (see the README for details):

- `UNTAPPD_USERNAME`, `UNTAPPD_PASSWORD` — your Untappd login.
- `UNTAPPD_CLIENT_ID`, `UNTAPPD_CLIENT_SECRET` — the Untappd mobile app client
  credentials (obtained by intercepting the app's traffic; see README).

Run `untappd_healthcheck` to confirm login works.

## Read tools

- `untappd_search_beer` / `untappd_beer_info` — find beers, then get full detail by bid.
- `untappd_search_brewery` / `untappd_brewery_info` — breweries.
- `untappd_search_venue` / `untappd_venue_info` — bars, breweries, restaurants.
- `untappd_venue_menu` — a venue's verified beer menu, flattened. Use instead of
  `venue_info` for "what's on tap" — `venue_info` returns only the first section
  of each menu and under-reports large boards. This pages sections under a
  per-call `max_pages` budget (like the sync tools) and is resumable: it returns
  `another_run_needed` + `next_section_offset` when the budget runs out, or
  `truncated` if the upstream stops returning sections short of coverage.
- `untappd_user_info` — a user's profile (omit `username` for your own).
- `untappd_user_checkins` — recent check-ins (page with `max_id`).
- `untappd_user_wishlist` — wishlist beers.
- `untappd_user_beers` — distinct beers ever checked in.
- `untappd_user_badges` / `untappd_user_friends`.
- `untappd_activity_feed` — your friend feed (page with `max_id`).
- `untappd_checkin_info` — full detail of one check-in.

Most user tools default `username` to your configured account when omitted.

## Write tools (confirm-gated — these post to your public account)

Each returns a dry-run preview and makes NO network call unless called with
`confirm: true`:

- `untappd_toast` — toast/like a check-in (this endpoint is a toggle).
- `untappd_add_comment` — comment on a check-in.
- `untappd_checkin` — post a new beer check-in to your feed (needs a `bid` from
  `untappd_search_beer`; optional `rating` 0–5 in 0.25 steps, `shout`, venue).

Photo attachment and wishlist add/remove are not yet supported.

## Check-in cache

The API can't answer "has this user ever had beer X?" without paging their whole
history (50/page, rate-limited). These tools keep a SQLite mirror so that
question is answered instantly with **no** API calls. On the stdio server the
mirror is a local file (`UNTAPPD_CACHE_DB`, default `~/.untappd-mcp/checkins.db`);
on the remote connector it's a per-user Durable Object. Same tools either way.

**Sync first, then query.** Two sources; both resumable (`max_pages`/call,
progress saved per page, `another_run_needed` until done). Omit `username` for
your own account; another user must be public or your friend.

- `untappd_sync_user_beers` — **start here for has-had questions.** Pages the
  user's COMPLETE distinct-beers list (cheap, and pages fully for anyone).
- `untappd_sync_checkins` — detailed check-ins (venue/date). Only your OWN
  account pages fully; for anyone else Untappd returns just the recent ~50 and
  the result reports `history_truncated` (it won't falsely claim
  `backfill_complete`). `force_backfill: true` resets a cache wrongly marked
  complete and re-pages (rows kept).

Query tools (has-had ones consult BOTH sources — a hit in either = had):

- `untappd_cache_has_had` — has the user had a beer? By exact `bid` or a
  case-insensitive `beer_name` substring.
- `untappd_cache_has_had_many` — batch had/not-had for a list of `bids`.
- `untappd_cache_not_had` — from a list of `bids`, the ones NOT had.
- `untappd_top_not_had` — from a list of `bids`, the top N NOT-had beers by
  Untappd rating, with an optional `style` filter ("what should I order off this
  tap list?"). Uses a `beer_meta` cache; calls `beer/info` only on miss/stale,
  capped at `api_budget` per run (partial/another_run_needed when exceeded).
- `untappd_cache_query` — filter cached check-ins by brewery, style, `min_rating`,
  venue, and date range.

Every cache read returns a `freshness` block reporting each source's completeness
separately (plus `coverage_complete` and a `caveat` when incomplete), so you can
flag a "not found" as possibly a false negative until the relevant sync finishes.
