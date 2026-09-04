import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { minifiedResult, resolveView, toolAnnotations, viewParam, viewResult } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactCheckins, UNTAPPD_VIEWS, upstreamCompact } from '../compact.js';

export function registerVenueTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_search_venue',
    {
      title: 'Search Untappd venues',
      description:
        'Search Untappd for venues (bars, breweries, restaurants) by name. Returns matches with their venue id, ' +
        'category, and location. Feed a venue id into untappd_venue_info for full detail. Read-only.',
      annotations: toolAnnotations({ title: 'Search Untappd venues', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        query: z.string().min(1).describe('Venue name to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1–50, default 25)'),
      },
    },
    async ({ query, limit }) => {
      const data = await client.get('/search/venue', { q: query, limit });
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'untappd_venue_info',
    {
      title: 'Get Untappd venue detail',
      description:
        'Get full detail for a venue by its Untappd venue id: category, address, contact, rating, total check-ins, ' +
        'and — on view:"full" — top beers and recent activity. Get an id from untappd_search_venue. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd venue detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact also asks Untappd for its own slim record, dropping the embedded activity/list blocks; "full" returns everything.' }),
      },
    },
    async ({ venue_id, view }) => {
      const v = resolveView(view, UNTAPPD_VIEWS);
      const data = await client.get(`/venue/info/${venue_id}`, { compact: upstreamCompact(v) });
      return viewResult(v, data);
    },
  );

  server.registerTool(
    'untappd_venue_menu',
    {
      title: "Get a venue's verified beer menu (section-paged)",
      description:
        "Return a venue's verified beer menu as a flat, compact list of beers. untappd_venue_info returns only the FIRST " +
        'section of each menu (Untappd defaults the section list to one), so it silently under-reports any venue whose menu ' +
        'spans multiple sections — e.g. a 23-beer wall that comes back with 2 items. This tool forwards the ' +
        'section_limit / section_offset paging params venue/info echoes back but never receives, walks sections up to a ' +
        'per-call max_pages budget (respecting the ~100 calls/hour limit — it does NOT loop to completion in one call), and ' +
        'flattens to [{bid, name, brewery, style, abv, price, serving_type, menu, section}]. Like the sync tools it is ' +
        'resumable: when the budget runs out before full coverage it returns another_run_needed:true plus next_section_offset ' +
        'to pass back on the next call. truncated:true means the upstream returned no more sections short of total_count ' +
        '(e.g. it ignored the paging params) — not resumable. Get an id from untappd_search_venue. Read-only.',
      annotations: toolAnnotations({ title: "Get a venue's verified beer menu (section-paged)", readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        menu_id: z.number().int().positive().optional().describe('Restrict to a single menu id (from a prior result). Optional.'),
        section_limit: z.number().int().min(1).max(50).optional().describe('Sections fetched per API call — page size (default 50).'),
        section_offset: z.number().int().min(0).optional().describe('Section offset to start from; pass a prior next_section_offset to resume (default 0).'),
        max_pages: z.number().int().min(1).max(10).optional().describe('API calls to spend THIS run — page budget, not page size (default 3). Resume with next_section_offset if another_run_needed.'),
        sort: z.string().optional().describe("Menu sort key (e.g. 'publish_order', 'highest_rated'). Optional."),
      },
    },
    async ({ venue_id, menu_id, section_limit, section_offset, max_pages, sort }) => {
      // venue/info pages its MENUS with limit/offset, but caps each menu's SECTION
      // list — echoing `section_limit`/`section_offset` back as accepted params
      // (the response even carries a `section_offset ` key with a stray trailing
      // space; the real param name is the clean one the web menu UI sends). We
      // forward them and walk sections, deduping by menu+section+bid so overlapping
      // or param-ignoring pages can't double-count. Per CLAUDE.md's rate-limit
      // design this spends at most `max_pages` API calls per run and hands the
      // caller next_section_offset to resume, rather than looping to completion.
      //
      // Termination is driven by SECTION availability, not a running beer count:
      // a page that returns fewer sections than we asked for is the end of the
      // list. That's what makes resuming correct — this tool is stateless across
      // calls, so on a resumed tail (section_offset > 0) `beers.length` covers
      // only this run and can never equal the whole-menu total, which would
      // otherwise mislabel a finished tail as truncated.
      const pageSize = section_limit ?? 50;
      const budget = max_pages ?? 3;
      const startOffset = section_offset ?? 0;
      let offset = startOffset;
      const seen = new Set<string>();
      const beers: Array<Record<string, unknown>> = [];
      let totalCount = 0;
      let sawMenu = false;
      let pagesFetched = 0;
      let reachedEnd = false; // hit full coverage, or the section list ran out

      for (let page = 0; page < budget; page++) {
        const data = await client.get<{ venue?: Record<string, unknown> }>(`/venue/info/${venue_id}`, {
          section_limit: pageSize,
          section_offset: offset,
          menu_id,
          sort,
        });
        pagesFetched++;
        const vb = (data?.venue as { verfied_beers?: Record<string, unknown> } | undefined)?.verfied_beers;
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
          if (menu_id && menu.menu_id !== menu_id) continue;
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
              beers.push({
                bid: beer.bid,
                name: beer.beer_name,
                brewery: (it.brewery as { brewery_name?: unknown } | undefined)?.brewery_name,
                style: beer.beer_style,
                abv: beer.beer_abv,
                price: (it.price as { value?: unknown } | undefined)?.value,
                serving_type: it.serving_type,
                menu: menu.menu_name,
                section: typeof sectionName === 'string' ? sectionName.trim() : sectionName,
              });
              added++;
            }
          }
        }
        // Coverage target: with a menu_id filter, aim for THAT menu's own item
        // count — verfied_beers.total_count spans every menu, so a single-menu
        // slice could never reach it (it would burn the whole page budget and
        // wrongly report a shortfall). Without a filter, the venue-wide total.
        totalCount = menu_id ? matchedItemCount : typeof vb.total_count === 'number' ? vb.total_count : totalCount;
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

      if (!sawMenu) {
        return minifiedResult({ venue_id, total_count: 0, returned: 0, pages_fetched: pagesFetched, another_run_needed: false, truncated: false, beers: [], note: 'No verified menu on this venue.' });
      }
      const covered = totalCount > 0 && beers.length >= totalCount;
      const another_run_needed = !reachedEnd; // stopped only because the page budget ran out mid-list
      // Only a walk that started at the top of the list can judge a genuine
      // shortfall as truncated; a resumed tail legitimately returns fewer than
      // the whole-menu total_count and is not truncated.
      const truncated = reachedEnd && !covered && startOffset === 0 && totalCount > 0;
      return minifiedResult({
        venue_id,
        total_count: totalCount,
        returned: beers.length,
        pages_fetched: pagesFetched,
        another_run_needed,
        ...(another_run_needed ? { next_section_offset: offset } : {}),
        truncated,
        beers,
      });
    },
  );

  server.registerTool(
    'untappd_venue_by_foursquare',
    {
      title: 'Look up an Untappd venue by Foursquare id',
      description:
        'Resolve a Foursquare venue id to its Untappd venue. Useful to turn a foursquare_id (e.g. from a check-in) ' +
        'into an Untappd venue you can pass to untappd_venue_info / untappd_venue_activity. Read-only.',
      annotations: toolAnnotations({ title: 'Look up an Untappd venue by Foursquare id', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        foursquare_id: z.string().min(1).describe('Foursquare venue id'),
      },
    },
    async ({ foursquare_id }) => {
      const data = await client.get(`/venue/foursquare_lookup/${encodeURIComponent(foursquare_id)}`);
      return minifiedResult(data);
    },
  );

  server.registerTool(
    'untappd_venue_activity',
    {
      title: 'Get recent check-ins at a venue',
      description:
        'Get the recent public check-ins at a venue by its id — who was there, what they drank, and their ratings. ' +
        'Page backwards with max_id (the pagination.max_id from a prior call). Read-only.',
      annotations: toolAnnotations({ title: 'Get recent check-ins at a venue', readOnly: true, idempotent: false, openWorld: true }),
      inputSchema: {
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact projects each check-in to {id, user, beer, brewery, venue, rating, comment, toast/comment counts}; "full" returns Untappd\'s whole ~5 KB record.' }),
      },
    },
    async ({ venue_id, limit, max_id, view }) => {
      const data = await client.get(`/venue/checkins/${venue_id}`, { limit, max_id });
      const v = resolveView(view, UNTAPPD_VIEWS);
      return viewResult(v, v === 'compact' ? compactCheckins(data) : data);
    },
  );
}
