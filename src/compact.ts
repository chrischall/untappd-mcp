// DEFAULT slim projections for the fat reverse-engineered list responses. A
// single check-in record is ~5 KB and a beer search item ~1.2 KB, so a page of
// 25 is a lot of agent context. These project each item down to the fields an
// agent usually needs, keyed off DOCUMENTED fields only, and derive nothing it
// can't. Every projector degrades safely: if the expected `<container>.items`
// array isn't present (the undocumented API drifted), it warns to stderr and
// returns the RAW response rather than an empty/wrong projection.
//
// These were opt-in until the fleet adopted the `view` vocabulary
// (@chrischall/mcp-utils): the schema said `compact: false` and the tool
// descriptions asked the caller to please pass `compact=true`. An efficiency
// that has to be requested is one that usually is not. `view` defaults to
// `compact` now; `view: "full"` is the way back to the raw record.

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | undefined {
  return v && typeof v === 'object' ? (v as Dict) : undefined;
}
function count(v: unknown): number | undefined {
  const d = asDict(v);
  if (!d) return undefined;
  return (d.count ?? d.total_count) as number | undefined;
}

/** Slim a single check-in record. */
export function compactCheckin(item: unknown): Dict {
  const c = asDict(item) ?? {};
  const beer = asDict(c.beer);
  const brewery = asDict(c.brewery);
  const venue = asDict(c.venue);
  const user = asDict(c.user);
  return {
    checkin_id: c.checkin_id,
    created_at: c.created_at,
    user: user?.user_name,
    rating: c.rating_score,
    comment: c.checkin_comment || undefined,
    beer: beer && { bid: beer.bid, name: beer.beer_name, style: beer.beer_style, abv: beer.beer_abv },
    brewery: brewery?.brewery_name,
    venue: venue?.venue_name || undefined,
    toasts: count(c.toasts),
    comments: count(c.comments),
    has_photo: (count(c.media) ?? 0) > 0,
  };
}

/** The beer fields common to every beer-list item (search, wishlist, distinct). */
function beerCore(item: Dict): Dict {
  const beer = asDict(item.beer) ?? {};
  const brewery = asDict(item.brewery);
  return {
    bid: beer.bid,
    name: beer.beer_name,
    style: beer.beer_style,
    abv: beer.beer_abv,
    ibu: beer.beer_ibu,
    brewery: brewery?.brewery_name,
  };
}

/** Slim a single beer-search result item. */
export function compactBeerResult(item: unknown): Dict {
  const i = asDict(item) ?? {};
  return { ...beerCore(i), checkin_count: i.checkin_count, have_had: i.have_had };
}

/** Slim a single wishlist item (adds when it was wishlisted). */
export function compactWishlistBeer(item: unknown): Dict {
  const i = asDict(item) ?? {};
  return { ...beerCore(i), added_at: i.created_at };
}

/** Slim a single distinct-beers (user/beers) item — your count, ratings, last had. */
export function compactUserBeer(item: unknown): Dict {
  const i = asDict(item) ?? {};
  return {
    ...beerCore(i),
    your_count: i.count,
    your_rating: i.user_auth_rating_score || undefined,
    global_rating: i.rating_score || undefined,
    last_had: i.recent_created_at,
  };
}

/**
 * Slim one `/brewery/beer_list/` item.
 *
 * This endpoint needs its OWN projector rather than reusing
 * {@link compactBeerResult}, and the reason is easy to miss: the item shape IS
 * `{beer:{…}, brewery:{…}}`-wrapped, so `beerCore` fits perfectly — but the two
 * fields the search projector adds on top of it are named differently here.
 * `/search/beer` says `checkin_count` / `have_had`; `/brewery/beer_list/` says
 * `total_count` / `has_had`. Reusing the search projector would therefore have
 * emitted a page of records carrying two silent `undefined`s — a beer with no
 * check-ins that you have never had — and `projectItems`' drift guard cannot
 * catch that, because the CONTAINER is exactly where it expects it to be.
 * Established against a live capture of brewery 1142, not by inference.
 *
 * Rating rides along because the tool's own description promises "per-beer
 * rating and check-in counts"; a compact rung that dropped them would
 * contradict the thing the caller was told they were getting.
 */
export function compactBreweryBeer(item: unknown): Dict {
  const i = asDict(item) ?? {};
  const beer = asDict(i.beer) ?? {};
  return {
    ...beerCore(i),
    rating: beer.rating_score,
    rating_count: beer.rating_count,
    checkin_count: i.total_count,
    have_had: i.has_had,
    your_count: i.total_user_count,
  };
}

/**
 * Project `<container>.items` in a response with `mapFn`, preserving the rest of
 * the container (pagination etc.). Drift-safe: returns the raw response
 * unchanged (with a stderr warning) when the array isn't where expected.
 */
export function projectItems(resp: unknown, container: string, mapFn: (item: unknown) => Dict): unknown {
  const r = asDict(resp);
  const box = asDict(r?.[container]);
  const items = box?.items;
  if (!r || !box || !Array.isArray(items)) {
    process.stderr.write(`[untappd-mcp] compact: expected ${container}.items array; returning raw response\n`);
    return resp;
  }
  return { ...r, [container]: { ...box, items: items.map(mapFn) } };
}

export const compactCheckins = (resp: unknown): unknown => projectItems(resp, 'checkins', compactCheckin);
export const compactBeerSearch = (resp: unknown): unknown => projectItems(resp, 'beers', compactBeerResult);
export const compactWishlist = (resp: unknown): unknown => projectItems(resp, 'beers', compactWishlistBeer);
export const compactUserBeers = (resp: unknown): unknown => projectItems(resp, 'beers', compactUserBeer);

/**
 * Project a brewery beer list, and drop `sorting_options` with it.
 *
 * `sorting_options` is 16 `{sort_key, sort_name}` pairs of UI chrome repeated on
 * every page. The tool's `sort` parameter is already a closed enum on its input
 * schema, so the list tells a caller nothing they were not handed with the
 * schema — it is pure duplication of a contract they already hold.
 */
export function compactBreweryBeers(resp: unknown): unknown {
  const projected = projectItems(resp, 'beers', compactBreweryBeer);
  // projectItems returns the SAME object on drift; don't reshape that.
  if (projected === resp) return resp;
  const { sorting_options: _dropped, ...rest } = projected as Dict;
  return rest;
}

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary,
 * and `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * No `raw`: nothing here re-serialises or normalises a payload, so `full`
 * already IS the upstream response and a third rung would be a value that
 * silently aliases to another.
 *
 * `compact` is the DEFAULT now, where it used to be `compact: false` with the
 * tool descriptions asking to please pass `compact=true`. A single check-in
 * record is ~5 KB and a beer-search item ~1.2 KB, so a default page of 25 was
 * costing a caller upwards of 100 KB to learn what someone drank — and the
 * caller paying for it was the one least able to know a slim rung existed.
 */
export const UNTAPPD_VIEWS = ['compact', 'full'] as const;

/**
 * Does this rung ALSO ask Untappd for less?
 *
 * `/user/info`, `/beer/info`, `/brewery/info` and `/venue/info` take their own
 * `compact=true`, which drops the embedded activity and list blocks server
 * side. That used to be a second, unrelated meaning of the same parameter name
 * in this repo — one `compact` projecting locally, another forwarded upstream.
 * They are the same intent, so one `view` now drives both: `compact` asks
 * Untappd for the slim record AND projects what comes back, which saves the
 * bandwidth as well as the context.
 */
export function upstreamCompact(view: string): 'true' | undefined {
  return view === 'compact' ? 'true' : undefined;
}
