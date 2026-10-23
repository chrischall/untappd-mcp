import type { UntappdClient } from '../client.js';

/** One flattened menu beer. */
export interface MenuBeer {
  bid: number;
  name: unknown;
  brewery: unknown;
  style: unknown;
  abv: unknown;
  price: unknown;
  serving_type: unknown;
  menu: unknown;
  section: unknown;
  /** The raw `beer` / `brewery` objects, for metadata seeding (not part of the tool output). */
  rawBeer: Record<string, unknown>;
  rawBrewery: Record<string, unknown> | undefined;
}

export interface VenueMenuWalk {
  beers: MenuBeer[];
  /** Coverage target: the venue-wide (or one menu's) item count. */
  totalCount: number;
  sawMenu: boolean;
  pagesFetched: number;
  /** Hit full coverage, or the section list ran out. False = budget ran out mid-list. */
  reachedEnd: boolean;
  /** Section offset to resume from. */
  nextOffset: number;
  /** The venue's city, from the first page's `venue.location` (for match tie-breaks). */
  venueCity: string | null;
  venueName: string | null;
}

export interface VenueMenuOptions {
  menuId?: number;
  sectionLimit?: number;
  sectionOffset?: number;
  maxPages: number;
  sort?: string;
}

/**
 * Walk a venue's verified menu sections via venue/info, spending at most
 * `maxPages` API calls.
 *
 * venue/info pages its MENUS with limit/offset, but caps each menu's SECTION
 * list — echoing `section_limit`/`section_offset` back as accepted params
 * (the response even carries a `section_offset ` key with a stray trailing
 * space; the real param name is the clean one the web menu UI sends). We
 * forward them and walk sections, deduping by menu+section+bid so overlapping
 * or param-ignoring pages can't double-count.
 *
 * Termination is driven by SECTION availability, not a running beer count:
 * a page that returns fewer sections than we asked for is the end of the
 * list. That's what makes resuming correct — the walk is stateless across
 * calls, so on a resumed tail (section_offset > 0) `beers.length` covers
 * only this run and can never equal the whole-menu total, which would
 * otherwise mislabel a finished tail as truncated.
 */
export async function walkVenueMenu(client: UntappdClient, venueId: number, opts: VenueMenuOptions): Promise<VenueMenuWalk> {
  const pageSize = opts.sectionLimit ?? 50;
  const menuId = opts.menuId;
  let offset = opts.sectionOffset ?? 0;
  const seen = new Set<string>();
  const beers: MenuBeer[] = [];
  let totalCount = 0;
  let sawMenu = false;
  let pagesFetched = 0;
  let reachedEnd = false;
  let venueCity: string | null = null;
  let venueName: string | null = null;

  for (let page = 0; page < opts.maxPages; page++) {
    const data = await client.get<{ venue?: Record<string, unknown> }>(`/venue/info/${venueId}`, {
      section_limit: pageSize,
      section_offset: offset,
      menu_id: menuId,
      sort: opts.sort,
    });
    pagesFetched++;
    const venue = data?.venue;
    if (page === 0 && venue) {
      const loc = venue.location as { venue_city?: unknown } | undefined;
      venueCity = typeof loc?.venue_city === 'string' ? loc.venue_city : null;
      venueName = typeof venue.venue_name === 'string' ? venue.venue_name : null;
    }
    const vb = (venue as { verfied_beers?: Record<string, unknown> } | undefined)?.verfied_beers;
    if (!vb) {
      reachedEnd = true; // no menu payload — nothing more to page
      break;
    }
    sawMenu = true;
    let added = 0;
    let matchedItemCount = 0;
    let sectionsReturned = 0;
    for (const wrap of (vb.items as Array<{ menu?: Record<string, unknown> }>) ?? []) {
      const menu = wrap?.menu as Record<string, unknown> | undefined;
      if (!menu) continue;
      if (menuId && menu.menu_id !== menuId) continue;
      if (typeof menu.total_item_count === 'number') matchedItemCount += menu.total_item_count;
      const sections = (menu.sections as { items?: unknown[] } | undefined)?.items ?? [];
      for (const section of sections as Array<Record<string, unknown>>) {
        sectionsReturned++;
        for (const it of (section.items as Array<Record<string, unknown>>) ?? []) {
          const beer = it?.beer as Record<string, unknown> | undefined;
          if (!beer || typeof beer.bid !== 'number') continue;
          const key = `${String(menu.menu_id)}:${String(section.section_id)}:${beer.bid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sectionName = section.section_name;
          const brewery = it.brewery as Record<string, unknown> | undefined;
          beers.push({
            bid: beer.bid,
            name: beer.beer_name,
            brewery: brewery?.brewery_name,
            style: beer.beer_style,
            abv: beer.beer_abv,
            price: (it.price as { value?: unknown } | undefined)?.value,
            serving_type: it.serving_type,
            menu: menu.menu_name,
            section: typeof sectionName === 'string' ? sectionName.trim() : sectionName,
            rawBeer: beer,
            rawBrewery: brewery,
          });
          added++;
        }
      }
    }
    // Coverage target: with a menu_id filter, aim for THAT menu's own item
    // count — verfied_beers.total_count spans every menu, so a single-menu
    // slice could never reach it (it would burn the whole page budget and
    // wrongly report a shortfall). Without a filter, the venue-wide total.
    totalCount = menuId ? matchedItemCount : typeof vb.total_count === 'number' ? vb.total_count : totalCount;
    offset += pageSize;
    if (totalCount > 0 && beers.length >= totalCount) {
      reachedEnd = true; // full coverage from this walk
      break;
    }
    if (sectionsReturned < pageSize || added === 0) {
      reachedEnd = true; // a short (or all-duplicate) page is the end of the section list
      break;
    }
  }
  return { beers, totalCount, sawMenu, pagesFetched, reachedEnd, nextOffset: offset, venueCity, venueName };
}
