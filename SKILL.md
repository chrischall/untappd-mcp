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
