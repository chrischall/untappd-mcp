import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, resolveView, toolAnnotations, viewParam, viewResult } from '@chrischall/mcp-utils';
import type { UntappdClient } from '../client.js';
import { compactCheckins, UNTAPPD_VIEWS, upstreamCompact } from '../compact.js';
import { walkVenueMenu } from '../menu/venue-menu.js';

export function registerVenueTools(server: McpServer, client: UntappdClient): void {
  server.registerTool(
    'untappd_search_venue',
    {
      title: 'Search Untappd venues',
      description:
        'Search Untappd for venues (bars, breweries, restaurants) by name. Returns matches with their venue id, ' +
        'category, and location. Feed a venue id into untappd_venue_info for full detail. Read-only.',
      annotations: toolAnnotations({ title: 'Search Untappd venues', readOnly: true, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        query: z.string().min(1).describe('Venue name to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1–50, default 25)'),
      }),
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
      inputSchema: z.object({
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact also asks Untappd for its own slim record, dropping the embedded activity/list blocks; "full" returns everything.' }),
      }),
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
      inputSchema: z.object({
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        menu_id: z.number().int().positive().optional().describe('Restrict to a single menu id (from a prior result). Optional.'),
        section_limit: z.number().int().min(1).max(50).optional().describe('Sections fetched per API call — page size (default 50).'),
        section_offset: z.number().int().min(0).optional().describe('Section offset to start from; pass a prior next_section_offset to resume (default 0).'),
        max_pages: z.number().int().min(1).max(10).optional().describe('API calls to spend THIS run — page budget, not page size (default 3). Resume with next_section_offset if another_run_needed.'),
        sort: z.string().optional().describe("Menu sort key (e.g. 'publish_order', 'highest_rated'). Optional."),
      }),
    },
    async ({ venue_id, menu_id, section_limit, section_offset, max_pages, sort }) => {
      // Per CLAUDE.md's rate-limit design this spends at most `max_pages` API
      // calls per run and hands the caller next_section_offset to resume, rather
      // than looping to completion. The walk itself lives in walkVenueMenu.
      const startOffset = section_offset ?? 0;
      const walk = await walkVenueMenu(client, venue_id, {
        menuId: menu_id,
        sectionLimit: section_limit,
        sectionOffset: startOffset,
        maxPages: max_pages ?? 3,
        sort,
      });
      const { totalCount, sawMenu, pagesFetched, reachedEnd } = walk;
      const beers = walk.beers.map(({ rawBeer: _b, rawBrewery: _w, ...b }) => b);

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
        ...(another_run_needed ? { next_section_offset: walk.nextOffset } : {}),
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
      inputSchema: z.object({
        foursquare_id: z.string().min(1).describe('Foursquare venue id'),
      }),
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
      inputSchema: z.object({
        venue_id: z.number().int().positive().describe('Untappd venue id'),
        limit: z.number().int().min(1).max(50).optional().describe('Max check-ins (1–50, default 25)'),
        max_id: z.number().int().positive().optional().describe('Return check-ins older than this id (for paging)'),
        view: viewParam(UNTAPPD_VIEWS, { note: 'compact projects each check-in to {id, user, beer, brewery, venue, rating, comment, toast/comment counts}; "full" returns Untappd\'s whole ~5 KB record.' }),
      }),
    },
    async ({ venue_id, limit, max_id, view }) => {
      const data = await client.get(`/venue/checkins/${venue_id}`, { limit, max_id });
      const v = resolveView(view, UNTAPPD_VIEWS);
      return viewResult(v, v === 'compact' ? compactCheckins(data) : data);
    },
  );
}
