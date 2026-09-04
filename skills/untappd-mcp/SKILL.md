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

## Response shape (`view`)

Twelve of this server's 45 tools take `view: "compact" | "full"`, and
**`compact` is the DEFAULT** — the slim rung is what you get without asking
for it.

**If you were told to pass `compact: true`, that advice is stale.** It used to
be true: the projection shipped as an opt-in boolean defaulting to `false`,
and the tool descriptions asked the caller to please turn it on. An efficiency
you have to request is one that mostly is not requested — and the caller
paying for the fat record was the one least able to know a slim rung existed.
So it flipped. The old parameter is gone; it is not declared anywhere, so zod
drops the unknown key and the call succeeds. You get the compact rung — right
answer, wrong reason. **The same silence bites the other way**: `compact:
false` no longer buys you the full record either. It is dropped identically
and you still get compact. `view: "full"` is the only way back.

Compact comes in two tiers here, and they are not the same thing:

**A hand-written field projection — 8 tools.**

- Check-ins (`untappd_activity_feed`, `untappd_user_checkins`,
  `untappd_beer_activity`, `untappd_venue_activity`,
  `untappd_local_checkins`): each ~5 KB record becomes `{checkin_id,
  created_at, user, rating, comment, beer{bid, name, style, abv}, brewery,
  venue, toasts, comments, has_photo}`. A default page of 25 was upwards of
  100 KB to learn what someone drank.
- `untappd_search_beer`: each ~1.2 KB match becomes `{bid, name, style, abv,
  ibu, brewery, checkin_count, have_had}` — the long `beer_description` and
  the nested brewery record go.
- `untappd_user_wishlist`: the same beer core plus `added_at`.
- `untappd_user_beers`: the same beer core plus `your_count`, `your_rating`,
  `global_rating`, `last_had`.

**An upstream request for less — 4 tools.** `untappd_user_info`,
`untappd_beer_info`, `untappd_brewery_info` and `untappd_venue_info` forward
`compact=true` to Untappd's own endpoint, which drops the embedded
activity/list blocks server side. **There is no local projection on these**:
the entity's own fields are byte-identical on both rungs. What compact saves
is Untappd's embedded blocks — and the bandwidth, not just the context. Do not
expect a shorter beer record from `untappd_beer_info`; expect the recent-
activity block to be absent.

The projectors are **drift-safe**. Each keys off a documented container
(`checkins.items`, `beers.items`); if that array is not where it is expected —
this is a reverse-engineered API — the projector warns on stderr and returns
the RAW response rather than an empty or wrong one. A short answer is never
silently manufactured.

`view: "full"` returns Untappd's response untouched. There is deliberately
**no `raw` rung**: nothing here re-serialises or normalises a payload, so
`full` already IS the upstream response and a third value would silently alias
one that exists.

### The 33 tools without `view`

Each for its own reason — and none of them will tell you it ignored the
parameter, because an undeclared key is dropped by zod without a warning:

- **The 11 confirm-gated writes** (`untappd_checkin`, `untappd_toast`,
  `untappd_add_comment`, the two deletes, the wishlist pair, the four friend
  actions) answer with a dry-run preview or a receipt. Nothing in a receipt is
  decoration.
- **`untappd_sync_checkins` / `untappd_sync_user_beers`** answer with sync
  PROGRESS — pages walked, `another_run_needed`, `backfill_complete`. Slimming
  a progress report is how you lose the field that says it is not finished.
- **The five cache tools** (`untappd_cache_has_had`, `…_has_had_many`,
  `…_not_had`, `untappd_cache_query`, `untappd_top_not_had`) answer from the
  local SQLite mirror in a shape this repo already wrote — a verdict plus the
  `freshness` block that says whether a "not found" might be a false negative.
  There is no upstream payload behind them to project away from.
- **`untappd_checkin_info`** exists to return the FULL record for one check-in
  — photos, badges earned, toasts, comments. The ~5 KB the check-in projection
  removes is exactly what you called this tool to get.
- **`untappd_venue_menu`** is already its own hand-written projection, with a
  per-call page budget and a resumable `next_section_offset` contract. A
  second projection on top of it would fight the first.
- **`untappd_resolve`, `untappd_open_url`, `untappd_healthcheck`** return a
  verdict or a diagnostic.
- **The remaining ten reads** — `untappd_trending`, `untappd_notifications`,
  `untappd_brewery_beers`, `untappd_search_brewery`, `untappd_search_venue`,
  `untappd_user_badges`, `untappd_user_friends`, `untappd_user_venues`,
  `untappd_pending_friends`, `untappd_venue_by_foursquare` — hand back
  Untappd's payload as it arrived. No projector has been written for their
  shapes, so there is no rung to ask for and **no slim option exists**.
  `untappd_brewery_beers` is the one worth budgeting for: it returns a beer
  list, which is the shape the beer projectors handle, but it is not wired to
  one — a 50-beer page arrives as 50 full records.

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
the store is injectable, so another deployment can back it differently. Same tools either way.

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
