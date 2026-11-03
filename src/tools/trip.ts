import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { RateLimitError, createHelpfulError, messageOf, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { DEFAULT_VISIT_RADIUS_M, haversineM, type BreweryBeerList, type BreweryBeerRow, type VenueQuery, type VisitedVenue } from '../cache/store.js';
import { BREWERY_BEERS_TTL_MS, getBreweryBeers } from '../cache/brewery-beers.js';
import { favoriteLookup, listFavorites } from '../cache/favorites.js';
import {
  DEFAULT_MULTI_USER_MODE,
  MAX_GROUP_USERS,
  MULTI_USER_MODES,
  multiHasHad,
  resolveUsers,
  type MultiUserMode,
} from '../cache/multi-user.js';
import { checkRateBudget, resumeAdvice, stopFrom429, stopFromVerdict, type RateStop } from '../ratelimit.js';
import {
  FAVORITE_BREWERY_BOOST,
  UsernameArg,
  WISHLIST_BOOST,
  freshness,
  groupFreshness,
  venueFreshness,
  type CacheProvider,
} from './cache.js';

/** Default radius of the "near a favorite" hint around a stop. */
export const NEAR_FAVORITE_RADIUS_M = 2000;
/** Default number of not-had beers listed per brewery stop. */
export const TRIP_TOP_N = 4;
/** Default brewery/beer_list calls one trip_check may spend on missing or stale lists. */
export const TRIP_DEFAULT_API_BUDGET = 5;
/** One brewery/beer_list call asks for this many beers (top of the popularity order). */
const TRIP_LIST_LIMIT = 50;
const MAX_NEAR_FAVORITES = 5;

const PlaceArg = z.object({
  label: z.string().max(200).optional().describe('Your own label for this stop, echoed back'),
  venue_id: z.number().int().positive().optional().describe('Untappd venue id of the stop'),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Venue name (case-insensitive substring or every significant word); defaults to the brewery name for a brewery_id stop'),
  city: z.string().min(1).max(100).optional().describe('Narrow a name match to venues whose city contains this'),
  state: z.string().min(1).max(100).optional().describe('Narrow a name match to venues whose state contains this (e.g. "FL")'),
  lat: z.number().min(-90).max(90).optional().describe('Latitude of the stop; needs lng'),
  lng: z.number().min(-180).max(180).optional().describe('Longitude of the stop; needs lat'),
  radius_m: z.number().positive().max(50_000).optional().describe(`Visit-match radius around lat/lng in metres (default ${DEFAULT_VISIT_RADIUS_M})`),
  brewery_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Untappd brewery id: adds beers-had and the top not-had beers from the brewery's (cached) beer list"),
});
type Place = z.infer<typeof PlaceArg>;

interface ListInfo {
  list: BreweryBeerList | undefined;
  source: 'cache' | 'api' | 'missing';
  stale: boolean;
  error?: string;
}

const ratingOf = (r: BreweryBeerRow) => r.rating_score ?? 0;
const minIso = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort()[0] ?? null;
const maxIso = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/** untappd_trip_check — a pre-trip sweep over several stops, cache first. */
export function registerTripTools(server: McpServer, client: UntappdClient, cacheProvider: CacheProvider): void {
  server.registerTool(
    'untappd_trip_check',
    {
      title: 'Check a list of trip stops against a user’s history (cache)',
      description:
        'Plan a brewery/bar crawl in ONE call: for each place (venue_id, name + city/state, lat/lng, and/or brewery_id) ' +
        'return whether the user has been there (dates, total visits, matched venues incl. "(duplicate of …)" copies — ' +
        'from the cached venue history, run untappd_sync_user_venues first), and for a brewery_id: how many of its ' +
        `beers they have had and the top ${TRIP_TOP_N} (top_n) NOT-had beers by Untappd global rating, optionally filtered by ` +
        'style (out-of-production beers skipped unless include_out_of_production). Has-had and visits come from the cache ' +
        'ONLY; the only API calls are brewery/beer_list fetches for a brewery whose list is not cached or is past its ' +
        `${BREWERY_BEERS_TTL_MS / 86_400_000}-day TTL, at most api_budget (default ${TRIP_DEFAULT_API_BUDGET}; 0 = strictly cache-only, ` +
        'a stale list is then used and flagged) under the ~100 calls/hour guard — a missing list sets another_run_needed. ' +
        'Beer lists are global facts: Untappd\'s have_had on that endpoint is the AUTHENTICATED account\'s and is never ' +
        'used. Favorites (derived from the cached history, or added with untappd_favorite_add) are flagged on matched ' +
        `venues, the brewery and beers; prefer_favorites (default true) lifts wishlisted beers (+${WISHLIST_BOOST}) and a ` +
        `favorite brewery's beers (+${FAVORITE_BREWERY_BOOST}); and a stop within near_favorite_radius_m (default ` +
        `${NEAR_FAVORITE_RADIUS_M} m) of a favorite venue gets near_favorites + a "Near a favorite" hint. For a GROUP pass ` +
        'usernames + mode ("none_had" default / "any_not_had"). Returns has-had and venue freshness blocks.',
      annotations: toolAnnotations({
        title: 'Check a list of trip stops against a user’s history (cache)',
        readOnly: true,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        username: UsernameArg,
        usernames: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_GROUP_USERS)
          .optional()
          .describe(`Check a GROUP (1–${MAX_GROUP_USERS}) instead of one user; use instead of username`),
        mode: z
          .enum(MULTI_USER_MODES)
          .optional()
          .describe('With usernames: "none_had" (default) lists beers new to everyone; "any_not_had" beers someone still needs'),
        places: z.array(PlaceArg).min(1).max(25).describe('The stops (1–25); each needs venue_id, name, lat+lng, or brewery_id'),
        top_n: z.number().int().min(1).max(10).optional().describe(`Not-had beers listed per brewery stop (default ${TRIP_TOP_N})`),
        style: z.string().min(1).optional().describe('Case-insensitive substring filter on the beer style (e.g. "ipa")'),
        prefer_favorites: z
          .boolean()
          .optional()
          .describe(`Boost wishlisted beers (+${WISHLIST_BOOST}) and favorite-brewery beers (+${FAVORITE_BREWERY_BOOST}) (default true)`),
        near_favorite_radius_m: z
          .number()
          .positive()
          .max(50_000)
          .optional()
          .describe(`Radius for the "near a favorite" hint in metres (default ${NEAR_FAVORITE_RADIUS_M})`),
        include_out_of_production: z.boolean().optional().describe('Also rank beers Untappd marks out of production (default false)'),
        max_matches: z.number().int().min(1).max(20).optional().describe('Most matched venues listed per user per stop (default 5)'),
        api_budget: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe(`Max brewery/beer_list calls for missing or stale lists (default ${TRIP_DEFAULT_API_BUDGET}; 0 = cache only)`),
      }),
    },
    async (args) => {
      const { username, usernames, mode, places, top_n, style, prefer_favorites, near_favorite_radius_m, include_out_of_production, max_matches, api_budget } =
        args;
      places.forEach((p, i) => {
        const hasGeo = p.lat !== undefined || p.lng !== undefined;
        if (hasGeo && (p.lat === undefined || p.lng === undefined)) {
          throw createHelpfulError(`Place ${i + 1}: lat and lng must be given together.`, { hint: 'Pass both, or match by name / venue_id instead.' });
        }
        if (p.venue_id === undefined && p.name === undefined && !hasGeo && p.brewery_id === undefined) {
          throw createHelpfulError(`Place ${i + 1} has nothing to match on.`, {
            hint: 'Give venue_id, a name (optionally with city/state), lat + lng, or brewery_id.',
          });
        }
      });
      const group = usernames !== undefined && usernames.length > 0;
      const users = resolveUsers(username, usernames, client.loginName);
      const groupMode: MultiUserMode = mode ?? DEFAULT_MULTI_USER_MODE;
      const cache = cacheProvider();
      const topN = top_n ?? TRIP_TOP_N;
      const preferFavorites = prefer_favorites ?? true;
      const nearRadius = near_favorite_radius_m ?? NEAR_FAVORITE_RADIUS_M;
      const maxMatches = max_matches ?? 5;
      const budget = api_budget ?? TRIP_DEFAULT_API_BUDGET;
      const now = Date.now();

      // 1. Brewery lists: cached when fresh; a missing/stale one is fetched within the budget.
      const lists = new Map<number, ListInfo>();
      let apiCalls = 0;
      let rateStop: RateStop | undefined;
      for (const id of [...new Set(places.map((p) => p.brewery_id).filter((x): x is number => x !== undefined))]) {
        const cached = await cache.getBreweryBeerList(id);
        const stale = cached !== undefined && now - Date.parse(cached.fetched_at) >= BREWERY_BEERS_TTL_MS;
        const info: ListInfo = { list: cached, source: cached ? 'cache' : 'missing', stale };
        lists.set(id, info);
        if ((cached && !stale) || apiCalls >= budget || rateStop) continue;
        const verdict = await checkRateBudget(client, cache);
        if (!verdict.ok) {
          rateStop = stopFromVerdict(verdict);
          continue;
        }
        apiCalls++;
        try {
          await getBreweryBeers(client, cache, id, { limit: TRIP_LIST_LIMIT, refresh: stale });
          lists.set(id, { list: await cache.getBreweryBeerList(id), source: 'api', stale: false });
        } catch (e) {
          if (e instanceof RateLimitError) rateStop = stopFrom429(e);
          else info.error = messageOf(e);
        }
      }

      // 2. Visits per place and user (cache only).
      const breweryNames = new Map<number, string | null>();
      for (const id of lists.keys()) {
        let name = lists.get(id)!.list?.brewery_name ?? null;
        for (const u of users) {
          if (name) break;
          name = (await cache.breweryHadStats(u, [id]))[0]?.brewery_name ?? null;
        }
        breweryNames.set(id, name);
      }
      const visits: Array<Array<{ username: string; matches: VisitedVenue[] }> | null> = [];
      for (const p of places) {
        const q: VenueQuery = {
          ...(p.venue_id !== undefined ? { venue_ids: [p.venue_id] } : {}),
          name: p.name ?? (p.venue_id === undefined && p.lat === undefined && p.brewery_id !== undefined ? (breweryNames.get(p.brewery_id) ?? undefined) : undefined),
          city: p.city,
          state: p.state,
          lat: p.lat,
          lng: p.lng,
          radius_m: p.radius_m,
        };
        if (!q.venue_ids && q.name === undefined && q.lat === undefined) {
          visits.push(null); // brewery stop whose name is unknown: cannot match
          continue;
        }
        const perUser = [];
        for (const u of users) perUser.push({ username: u, matches: await cache.findVisitedVenues(u, q) });
        visits.push(perUser);
      }

      // 3. Favorite venues with known coordinates, for the near-a-favorite hint.
      const favVenueIds = new Set<number>();
      for (const u of users) for (const f of await listFavorites(cache, u, { kind: 'venue' })) favVenueIds.add(f.id);
      const favVenues = (await cache.getVenues([...favVenueIds])).filter((v) => v.lat !== null && v.lng !== null);
      const placeVenues = await cache.getVenues(places.map((p) => p.venue_id).filter((x): x is number => x !== undefined));
      const placeVenueById = new Map(placeVenues.map((v) => [v.venue_id, v]));

      // 4. Not-had candidates per brewery (cache only).
      const style_ = style?.toLowerCase();
      const candidates = new Map<number, BreweryBeerRow[]>();
      for (const [id, info] of lists) {
        const rows = (info.list?.beers ?? []).filter(
          (r) => (include_out_of_production || r.in_production !== false) && (style_ === undefined || (r.style?.toLowerCase().includes(style_) ?? false)),
        );
        candidates.set(id, rows);
      }
      const allBids = [...new Set([...candidates.values()].flat().map((r) => r.bid))];
      const verdicts = await multiHasHad(cache, users, allBids, groupMode);
      const wishlisted = new Set<number>();
      for (const u of users) for (const w of await cache.getWishlist(u, allBids)) wishlisted.add(w.bid);
      const favs = await favoriteLookup(cache, users, {
        venue: [...visits.flatMap((v) => (v ?? []).flatMap((x) => x.matches.map((m) => m.venue_id))), ...favVenueIds, ...placeVenueById.keys()],
        brewery: [...lists.keys()],
        beer: allBids,
      });

      // 5. Assemble.
      let visitedCount = 0;
      let missingLists = 0;
      let staleLists = 0;
      const out = places.map((p, i) => {
        const perUser = visits[i];
        const visited = perUser ? perUser.some((x) => x.matches.length > 0) : null;
        if (visited) visitedCount++;
        const matchedIds = new Set<number>([...(perUser ?? []).flatMap((x) => x.matches.map((m) => m.venue_id)), ...(p.venue_id ? [p.venue_id] : [])]);
        const res: Record<string, unknown> = {
          ...(p.label !== undefined ? { label: p.label } : {}),
          place: { ...p, label: undefined },
          visited,
          ...(perUser
            ? {
                visits: perUser.map(({ username: u, matches }) => ({
                  username: u,
                  visited: matches.length > 0,
                  total_visits: matches.reduce((n, m) => n + (m.total_count ?? 0), 0),
                  first_visit: minIso(matches.map((m) => m.first_visit)),
                  recent_visit: maxIso(matches.map((m) => m.recent_visit)),
                  match_count: matches.length,
                  matches: matches.slice(0, maxMatches).map((m) => ({
                    venue_id: m.venue_id,
                    name: m.name,
                    city: m.city,
                    state: m.state,
                    ...(m.is_duplicate ? { is_duplicate: true } : {}),
                    ...(m.distance_m !== undefined ? { distance_m: m.distance_m } : {}),
                    first_visit: m.first_visit,
                    recent_visit: m.recent_visit,
                    total_count: m.total_count,
                    favorite: favs.get('venue', m.venue_id),
                  })),
                })),
              }
            : { visit_note: 'No venue name is known for this brewery yet — pass name (and city) to check visits.' }),
          favorite_venue: [...matchedIds].some((id) => favs.isFavorite('venue', id)),
        };

        if (p.brewery_id !== undefined) {
          const id = p.brewery_id;
          const info = lists.get(id)!;
          if (info.source === 'missing') missingLists++;
          if (info.stale) staleLists++;
          const rows = candidates.get(id)!;
          const notHad = rows.filter((r) => verdicts.get(r.bid)?.qualifies);
          const breweryFav = favs.get('brewery', id);
          const boostsOf = (r: BreweryBeerRow): Array<'wishlist' | 'favorite_brewery'> => {
            if (!preferFavorites) return [];
            const b: Array<'wishlist' | 'favorite_brewery'> = [];
            if (wishlisted.has(r.bid)) b.push('wishlist');
            if (breweryFav.is_favorite) b.push('favorite_brewery');
            return b;
          };
          const scoreOf = (r: BreweryBeerRow) =>
            ratingOf(r) + boostsOf(r).reduce((n, b) => n + (b === 'wishlist' ? WISHLIST_BOOST : FAVORITE_BREWERY_BOOST), 0);
          const ranked = notHad
            .slice()
            .sort((a, b) => scoreOf(b) - scoreOf(a) || ratingOf(b) - ratingOf(a) || a.bid - b.bid)
            .slice(0, topN)
            .map((r) => {
              const boosts = boostsOf(r);
              const beerFav = favs.get('beer', r.bid);
              const v = verdicts.get(r.bid)!;
              return {
                bid: r.bid,
                name: r.beer_name,
                style: r.style,
                abv: r.abv,
                rating: r.rating_score,
                rating_count: r.rating_count,
                ...(r.in_production === false ? { in_production: false } : {}),
                ...(boosts.length ? { score: Number(scoreOf(r).toFixed(3)), boosted_by: boosts } : {}),
                ...(wishlisted.has(r.bid) ? { wishlisted: true } : {}),
                ...(beerFav.is_favorite ? { favorite: beerFav } : {}),
                ...(group ? { not_had_by: v.not_had_by, had_by: v.had_by.map((x) => x.username) } : {}),
              };
            });
          res.brewery = {
            brewery_id: id,
            brewery_name: breweryNames.get(id) ?? null,
            source: info.source,
            stale: info.stale,
            fetched_at: info.list?.fetched_at ?? null,
            ...(info.error ? { error: info.error } : {}),
            beers_in_list: info.list?.beers.length ?? 0,
            total_count: info.list?.total_count ?? null,
            not_had_in_list: notHad.length,
            favorite: breweryFav,
          };
          res.top_not_had = ranked;
        }
        return res;
      });

      // beers_had per brewery stop (async, so outside the map).
      for (let i = 0; i < places.length; i++) {
        const id = places[i].brewery_id;
        if (id === undefined) continue;
        const brewery = out[i].brewery as Record<string, unknown>;
        const counts: Record<string, number> = {};
        for (const u of users) counts[u] = (await cache.breweryHadStats(u, [id]))[0]?.beers ?? 0;
        if (group) brewery.beers_had_by = counts;
        else brewery.beers_had = counts[users[0]];
      }

      // Near-a-favorite hint: centre = the stop's lat/lng, else its first matched venue with coordinates.
      for (let i = 0; i < places.length; i++) {
        const p = places[i];
        let centre: { lat: number; lng: number } | null = p.lat !== undefined && p.lng !== undefined ? { lat: p.lat, lng: p.lng } : null;
        const matches = (visits[i] ?? []).flatMap((x) => x.matches);
        if (!centre && p.venue_id !== undefined) {
          const v = placeVenueById.get(p.venue_id);
          if (v && v.lat !== null && v.lng !== null) centre = { lat: v.lat, lng: v.lng };
        }
        if (!centre) {
          const m = matches.find((x) => x.lat !== null && x.lng !== null);
          if (m) centre = { lat: m.lat!, lng: m.lng! };
        }
        if (!centre) continue;
        const exclude = new Set<number>([...matches.map((m) => m.venue_id), ...(p.venue_id ? [p.venue_id] : [])]);
        const near = favVenues
          .filter((v) => !exclude.has(v.venue_id))
          .map((v) => ({ v, d: Math.round(haversineM(centre!.lat, centre!.lng, v.lat!, v.lng!)) }))
          .filter((x) => x.d <= nearRadius)
          .sort((a, b) => a.d - b.d)
          .slice(0, MAX_NEAR_FAVORITES);
        if (near.length === 0) continue;
        out[i].near_favorites = near.map(({ v, d }) => ({
          venue_id: v.venue_id,
          name: v.name,
          city: v.city,
          distance_m: d,
          favorite: favs.get('venue', v.venue_id),
        }));
        out[i].hint = `Near a favorite: ${near.map(({ v, d }) => `${v.name ?? `venue ${v.venue_id}`} (${d} m)`).join(', ')}`;
      }

      const partial = missingLists > 0 || staleLists > 0;
      const venueFresh = group
        ? Object.fromEntries(await Promise.all(users.map(async (u) => [u, await venueFreshness(cache, u)] as const)))
        : await venueFreshness(cache, users[0]);
      return minifiedResult({
        ...(group ? { usernames: users, mode: groupMode } : { username: users[0] }),
        places: out,
        summary: {
          places: places.length,
          visited: visitedCount,
          prefer_favorites: preferFavorites,
          near_favorite_radius_m: nearRadius,
          api_calls_used: apiCalls,
          ...(missingLists ? { brewery_lists_missing: missingLists } : {}),
          ...(staleLists ? { brewery_lists_stale: staleLists } : {}),
          partial,
          another_run_needed: partial,
          stopped_for_rate_limit: rateStop !== undefined,
          ...(rateStop ? { rate_limit: rateStop, note: resumeAdvice(rateStop, 'untappd_trip_check') } : {}),
        },
        freshness: {
          beers: group ? await groupFreshness(cache, users) : await freshness(cache, users[0]),
          venues: group ? { by_user: venueFresh } : venueFresh,
        },
      });
    },
  );
}
