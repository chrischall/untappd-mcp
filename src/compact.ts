// Opt-in slim projections for the fat reverse-engineered list responses. A
// single check-in record is ~5 KB and a beer search item ~1.2 KB, so a page of
// 25 is a lot of agent context. These project each item down to the fields an
// agent usually needs, keyed off DOCUMENTED fields only, and derive nothing it
// can't. Every projector degrades safely: if the expected `<container>.items`
// array isn't present (the undocumented API drifted), it warns to stderr and
// returns the RAW response rather than an empty/wrong projection.

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
