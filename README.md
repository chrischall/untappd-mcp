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
| `UNTAPPD_USERNAME` | yes | Your Untappd username or login email. |
| `UNTAPPD_PASSWORD` | yes | Your Untappd password (used only for the xauth login). |
| `UNTAPPD_CLIENT_ID` | yes | The Untappd mobile app client id (see below). |
| `UNTAPPD_CLIENT_SECRET` | yes | The Untappd mobile app client secret. |
| `UNTAPPD_DEVICE_ID` | no | Stable device UUID the token is keyed to (a default is provided). |
| `UNTAPPD_UTV` | no | API version param (default `4.0.0`). |
| `UNTAPPD_USER_AGENT` | no | Override the User-Agent (default mimics the app). |

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
`untappd_user_beers`, `untappd_user_badges`, `untappd_user_friends`,
`untappd_activity_feed`, `untappd_checkin_info`, `untappd_trending`,
`untappd_notifications`, `untappd_local_checkins`, `untappd_healthcheck`.

Writes (confirm-gated — return a dry-run preview unless called with
`confirm: true`): `untappd_toast`, `untappd_add_comment`, `untappd_delete_comment`, `untappd_checkin`,
`untappd_wishlist_add`, `untappd_wishlist_remove`, `untappd_delete_checkin`.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
