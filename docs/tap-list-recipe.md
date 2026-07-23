# Recipe: "What's new to this user?" from a tap-list photo

Given a photo of a taproom's beer menu and a target user, report which beers on
it that user has **not** checked in on Untappd. This is the cheapest path that is
still **correct** — the two are in tension, and most obvious "make it faster"
shortcuts silently drop beers. The rules below are what survived testing.

## The constraint

Untappd's mobile API is **~100 calls/hour per token** (see `CLAUDE.md`). Every
call spent resolving a menu is a call you can't spend elsewhere that hour, so the
whole design minimizes calls **without** trading away accuracy.

## Cost model

For a menu of `N` beers across `B` breweries:

| Step | Tool | API calls |
| --- | --- | --- |
| 1. Transcribe the menu | (vision, no tool) | 0 |
| 2. Resolve each beer → `bid` | `untappd_search_beer` ×N, one parallel batch | `N` |
| 3. Sync the target's distinct beers | `untappd_sync_user_beers` until `another_run_needed:false` | pages ≈ `their_distinct_beers / 50` |
| 4. Cross-check the whole menu | `untappd_cache_has_had_many(bids, username)` | **0** (cache-only) |

Step 4 is free. Step 2 is a fixed floor of one call per beer. Step 3 is the
dominant cost for a heavy user and is the one worth thinking about.

## Efficiency rules that cost **nothing** in correctness

1. **Resolve each `bid` once, then reuse it across users and re-runs.** A physical
   menu's beers map to the same bids forever. Running the *same* menu for a second
   user should cost about **2 calls** — an incremental `sync_user_beers` (1–2
   pages) plus the free `has_had_many` — not another full resolve. (In practice,
   checking a menu against a second, already-synced user came in at 2 calls versus
   ~28 for the first.)
2. **Fire all `search_beer` calls in a single parallel batch.** Never serialize.
3. **`compact: true`, and `limit: 1` for distinctive names.** Reserve `limit: 5`
   only for generic house entries (`Blonde Ale`, `Hazy IPA`, `Red Ale`) where you
   must pick the flagship by `checkin_count`.
4. **Project large payloads down to `bid` + `name` (e.g. with `jq`)** before
   reasoning over them, to keep context small.

## Shortcuts that look efficient but **break correctness** — don't use them

### ❌ Batching resolution by brewery via `untappd_brewery_beers`

A tap list is grouped by brewery, so it is tempting to pull each brewery's whole
catalog in one call and match locally — `B` calls instead of `N`. **It silently
drops beers.** `untappd_brewery_beers` returns ≤50 beers ranked by popularity and
omits some of a brewery's *most iconic* beers.

Measured on Eddyline (brewery id `9974`), the catalog listing omitted:

- **Crank Yanker** — 34,626 check-ins
- **River Runners Pale Ale** — 12,380 check-ins
- **Boater Beer** — 3,110 check-ins

All three are found instantly by per-beer `search_beer`. Batching by brewery would
report them as unresolved and under-count the menu. (It is also token-heavy —
~90 KB per brewery, with no `compact` option.) **Keep per-beer search.**

### ❌ Bounded / "recent pages only" sync

Syncing only the target's most recent pages is far cheaper than full coverage, but
`has_had` needs the beer *present in the cache*, so a bounded sync **false-negatives
old beers** — reporting a beer they've had as "new." Real example: a test user last
had River Runners Pale Ale in **2017**; a recent-only sync would miss that check-in
and wrongly call it new.

Sync to `another_run_needed:false`. When you can't (rate budget), trust the
`freshness` block: it reports each source's completeness separately and adds a
`caveat`, so an incomplete "not had" can be flagged as a possible false negative
rather than asserted.

## Report shape

Group by brewery. Lead with the shorter of had / not-had and state the ratio up
front. Include the last-had date for anything they've had. List any beer you could
not resolve to a `bid` as **unverified** — never silently drop it. Close with the
sync coverage percentage so the reader knows how much to trust the result.

## Read-only

This whole operation is read-only. Never check in, toast, wishlist, comment, or
modify anything while answering it.
