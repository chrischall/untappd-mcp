import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactCheckins } from '../compact.js';

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
      return textResult(data);
    },
  );

  server.registerTool(
    'untappd_venue_info',
    {
      title: 'Get Untappd venue detail',
      description:
        'Get full detail for a venue by its Untappd venue id: category, address, contact, rating, total check-ins, ' +
        'and (unless compact) top beers and recent activity. Get an id from untappd_search_venue. Read-only.',
      annotations: toolAnnotations({ title: 'Get Untappd venue detail', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: {
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        compact: z.boolean().optional().describe('Return a slimmer record without embedded activity (default false)'),
      },
    },
    async ({ venue_id, compact }) => {
      const data = await client.get(`/venue/info/${venue_id}`, { compact: compact ? 'true' : undefined });
      return textResult(data);
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
      const pageSize = section_limit ?? 50;
      const budget = max_pages ?? 3;
      let offset = section_offset ?? 0;
      const seen = new Set<string>();
      const beers: Array<Record<string, unknown>> = [];
      let totalCount = 0;
      let sawMenu = false;
      let pagesFetched = 0;
      let exhausted = false; // a page returned no new sections — no point paging further

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
          exhausted = true;
          break;
        }
        sawMenu = true;
        let added = 0;
        let matchedItemCount = 0;
        for (const wrap of (vb.items as Array<{ menu?: Record<string, unknown> }>) ?? []) {
          const menu = wrap?.menu as Record<string, unknown> | undefined;
          if (!menu) continue;
          if (menu_id && menu.menu_id !== menu_id) continue;
          if (typeof menu.total_item_count === 'number') matchedItemCount += menu.total_item_count;
          const sections = (menu.sections as { items?: unknown[] } | undefined)?.items ?? [];
          for (const section of sections as Array<Record<string, unknown>>) {
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
        if (added === 0) {
          exhausted = true; // upstream gave no new sections — resuming won't help
          break;
        }
        offset += pageSize;
        if (totalCount > 0 && beers.length >= totalCount) break; // full coverage
      }

      if (!sawMenu) {
        return textResult({ venue_id, total_count: 0, returned: 0, pages_fetched: pagesFetched, another_run_needed: false, truncated: false, beers: [], note: 'No verified menu on this venue.' });
      }
      const covered = totalCount > 0 && beers.length >= totalCount;
      const another_run_needed = !covered && !exhausted; // stopped only because the page budget ran out
      const truncated = !covered && exhausted; // upstream returned no more sections short of total_count
      return textResult({
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
      return textResult(data);
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
        compact: z
          .boolean()
          .optional()
          .describe('Project each check-in to a slim summary to save context (default false)'),
      },
    },
    async ({ venue_id, limit, max_id, compact }) => {
      const data = await client.get(`/venue/checkins/${venue_id}`, { limit, max_id });
      return textResult(compact ? compactCheckins(data) : data);
    },
  );
}
