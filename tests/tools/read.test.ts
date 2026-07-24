import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { UntappdClient } from '../../src/client.js';
import { registerBeerTools } from '../../src/tools/beer.js';
import { registerBreweryTools } from '../../src/tools/brewery.js';
import { registerVenueTools } from '../../src/tools/venue.js';
import { registerUserTools } from '../../src/tools/user.js';
import { registerFeedTools } from '../../src/tools/feed.js';
import { registerDiscoverTools } from '../../src/tools/discover.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { createTestHarness } from '../helpers.js';

const client = new UntappdClient();
const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => get.mockClear());
afterAll(async () => {
  if (harness) await harness.close();
});

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('read tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => {
      registerBeerTools(server, client);
      registerBreweryTools(server, client);
      registerVenueTools(server, client);
      registerUserTools(server, client);
      registerFeedTools(server, client);
      registerDiscoverTools(server, client);
      registerUtilityTools(server, client);
    });
  });

  it('search_beer maps query to q and passes paging', async () => {
    get.mockResolvedValueOnce({ beers: { items: [] } });
    await harness.callTool('untappd_search_beer', { query: 'pliny', limit: 5, offset: 10 });
    expect(get).toHaveBeenCalledWith('/search/beer', { q: 'pliny', limit: 5, offset: 10, sort: undefined });
  });

  it('search_beer compact projects results to slim summaries', async () => {
    get.mockResolvedValueOnce({ beers: { items: [{ checkin_count: 5, have_had: false, beer: { bid: 9, beer_name: 'A', beer_style: 'IPA', beer_abv: 6 }, brewery: { brewery_name: 'B' } }] } });
    const r = await harness.callTool('untappd_search_beer', { query: 'a', compact: true });
    const item = (parse(r as never).beers as any).items[0];
    expect(item).toEqual({ bid: 9, name: 'A', style: 'IPA', abv: 6, ibu: undefined, brewery: 'B', checkin_count: 5, have_had: false });
  });

  it('beer_info hits the bid path with compact', async () => {
    get.mockResolvedValueOnce({ beer: { bid: 4499 } });
    const r = await harness.callTool('untappd_beer_info', { bid: 4499, compact: true });
    expect(get).toHaveBeenCalledWith('/beer/info/4499', { compact: 'true' });
    expect((parse(r as never).beer as { bid: number }).bid).toBe(4499);
  });

  it('beer_info omits compact when false', async () => {
    get.mockResolvedValueOnce({ beer: {} });
    await harness.callTool('untappd_beer_info', { bid: 1 });
    expect(get).toHaveBeenCalledWith('/beer/info/1', { compact: undefined });
  });

  it('brewery_info hits the id path', async () => {
    get.mockResolvedValueOnce({ brewery: {} });
    await harness.callTool('untappd_brewery_info', { brewery_id: 5143 });
    expect(get).toHaveBeenCalledWith('/brewery/info/5143', { compact: undefined });
  });

  it('venue_info hits the id path', async () => {
    get.mockResolvedValueOnce({ venue: {} });
    await harness.callTool('untappd_venue_info', { venue_id: 1, compact: true });
    expect(get).toHaveBeenCalledWith('/venue/info/1', { compact: 'true' });
  });

  // Build one menu whose beers are split across the given sections (each an
  // array of bids). total_item_count is the menu's own beer count. Mirrors the
  // real verfied_beers[].menu shape.
  function beerMenu(menuId: number, menuName: string, sections: number[][]) {
    return {
      menu: {
        menu_id: menuId,
        menu_name: menuName,
        total_item_count: sections.reduce((n, s) => n + s.length, 0),
        sections: {
          count: sections.length,
          items: sections.map((bids, i) => ({
            section_id: menuId * 100 + i,
            section_name: `Section ${i} `,
            total_count: bids.length,
            count: bids.length,
            items: bids.map((bid) => ({
              price: { value: '8.00 USD' },
              serving_type: '16oz Draft',
              beer: { bid, beer_name: `Beer ${bid}`, beer_style: 'IPA', beer_abv: 6 },
              brewery: { brewery_name: `Brewery ${bid}` },
            })),
          })),
        },
      },
    };
  }
  const venuePayload = (totalCount: number, menus: ReturnType<typeof beerMenu>[]) => ({
    venue: { verfied_beers: { total_count: totalCount, items: menus } },
  });
  const oneMenu = (totalCount: number, sections: number[][]) =>
    venuePayload(totalCount, [beerMenu(152166240, 'Beer Menu', sections)]);

  it('venue_menu forwards section paging params and flattens every section to full coverage (venue 11123816 → 23)', async () => {
    // The 23-beer oracle: one page (section_limit 50) returns all sections.
    const bids = Array.from({ length: 23 }, (_, i) => 1000 + i);
    get.mockResolvedValueOnce(oneMenu(23, [bids.slice(0, 8), bids.slice(8, 16), bids.slice(16)]));
    const r = await harness.callTool('untappd_venue_menu', { venue_id: 11123816 });
    expect(get).toHaveBeenCalledWith('/venue/info/11123816', {
      section_limit: 50,
      section_offset: 0,
      menu_id: undefined,
      sort: undefined,
    });
    expect(get).toHaveBeenCalledTimes(1); // full coverage reached in one call
    const out = parse(r as never);
    expect(out.total_count).toBe(23);
    expect(out.returned).toBe(23);
    expect(out.truncated).toBe(false);
    expect(out.another_run_needed).toBe(false);
    expect((out.beers as unknown[]).length).toBe(23);
    expect((out.beers as Array<Record<string, unknown>>)[0]).toEqual({
      bid: 1000, name: 'Beer 1000', brewery: 'Brewery 1000', style: 'IPA', abv: 6,
      price: '8.00 USD', serving_type: '16oz Draft', menu: 'Beer Menu', section: 'Section 0',
    });
  });

  it('venue_menu spends its max_pages budget then reports another_run_needed with a resume offset', async () => {
    get.mockResolvedValueOnce(oneMenu(6, [[10, 11]])); // page 1 @ offset 0
    get.mockResolvedValueOnce(oneMenu(6, [[12, 13]])); // page 2 @ offset 2 — budget exhausted here
    const r = await harness.callTool('untappd_venue_menu', { venue_id: 5, section_limit: 2, max_pages: 2 });
    expect(get).toHaveBeenNthCalledWith(1, '/venue/info/5', { section_limit: 2, section_offset: 0, menu_id: undefined, sort: undefined });
    expect(get).toHaveBeenNthCalledWith(2, '/venue/info/5', { section_limit: 2, section_offset: 2, menu_id: undefined, sort: undefined });
    expect(get).toHaveBeenCalledTimes(2); // stops at the page budget — no unbounded loop
    const out = parse(r as never);
    expect(out.returned).toBe(4);
    expect(out.another_run_needed).toBe(true);
    expect(out.next_section_offset).toBe(4);
    expect(out.truncated).toBe(false);
  });

  it('venue_menu resumes from section_offset and reaches full coverage', async () => {
    get.mockResolvedValueOnce(oneMenu(6, [[14, 15]])); // resume page @ offset 4 completes coverage
    const r = await harness.callTool('untappd_venue_menu', { venue_id: 5, section_limit: 2, section_offset: 4 });
    expect(get).toHaveBeenNthCalledWith(1, '/venue/info/5', { section_limit: 2, section_offset: 4, menu_id: undefined, sort: undefined });
    const out = parse(r as never);
    expect(out.returned).toBe(2);
    expect(out.another_run_needed).toBe(false);
  });

  it('venue_menu with menu_id targets that menu\'s own count, not the venue-wide total', async () => {
    // Two menus, venue-wide total_count 8; asking for just menu 100 (4 beers)
    // must reach coverage on page 1 — not chase 8 and burn the page budget.
    get.mockResolvedValueOnce(
      venuePayload(8, [beerMenu(100, 'Draft', [[1, 2, 3, 4]]), beerMenu(200, 'Bottles', [[5, 6, 7, 8]])]),
    );
    const r = await harness.callTool('untappd_venue_menu', { venue_id: 9, menu_id: 100 });
    expect(get).toHaveBeenCalledTimes(1); // covered immediately — no wasted calls
    const out = parse(r as never);
    expect(out.total_count).toBe(4);
    expect(out.returned).toBe(4);
    expect(out.another_run_needed).toBe(false);
    expect(out.truncated).toBe(false);
    expect((out.beers as Array<Record<string, unknown>>).every((b) => b.menu === 'Draft')).toBe(true);
  });

  it('venue_menu flags truncated and stops when the upstream ignores paging', async () => {
    // Every call returns the same first section — dedup makes the 2nd page add
    // nothing, so it must stop (no infinite loop) and report the shortfall.
    get.mockResolvedValue(oneMenu(23, [[10, 11]]));
    const r = await harness.callTool('untappd_venue_menu', { venue_id: 7 });
    const out = parse(r as never);
    expect(out.returned).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.another_run_needed).toBe(false); // not resumable — resuming returns the same section
    expect(get).toHaveBeenCalledTimes(2); // 1 page of progress + 1 that added nothing
    get.mockReset();
    get.mockResolvedValue(undefined as never);
  });

  it('user_checkins uses an explicit username and passes max_id', async () => {
    get.mockResolvedValueOnce({ checkins: { items: [] } });
    await harness.callTool('untappd_user_checkins', { username: 'someone', limit: 3, max_id: 999 });
    expect(get).toHaveBeenCalledWith('/user/checkins/someone', { limit: 3, max_id: 999 });
  });

  it('user_info url-encodes the username', async () => {
    get.mockResolvedValueOnce({ user: {} });
    await harness.callTool('untappd_user_info', { username: 'a b' });
    expect(get).toHaveBeenCalledWith('/user/info/a%20b', { compact: undefined });
  });

  it('user tool errors clearly when no username and no configured account', async () => {
    // Force "no configured account" regardless of any ambient .env / env var.
    const loginName = vi.spyOn(client, 'loginName', 'get').mockReturnValue(null);
    try {
      const r = await harness.callTool('untappd_user_wishlist', {});
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(get).not.toHaveBeenCalled();
    } finally {
      loginName.mockRestore();
    }
  });

  it('user tool falls back to the configured account when username is omitted', async () => {
    const loginName = vi.spyOn(client, 'loginName', 'get').mockReturnValue('me');
    try {
      get.mockResolvedValueOnce({ beers: {} });
      await harness.callTool('untappd_user_wishlist', {});
      expect(get).toHaveBeenCalledWith('/user/wishlist/me', { limit: undefined, offset: undefined, sort: undefined });
    } finally {
      loginName.mockRestore();
    }
  });

  it('pending_friends calls /user/pending', async () => {
    get.mockResolvedValueOnce({ count: 0, items: [] });
    await harness.callTool('untappd_pending_friends', { limit: 10 });
    expect(get).toHaveBeenCalledWith('/user/pending', { limit: 10, offset: undefined });
  });

  it('activity_feed calls /checkin/recent', async () => {
    get.mockResolvedValueOnce({ checkins: { items: [] } });
    await harness.callTool('untappd_activity_feed', { limit: 10 });
    expect(get).toHaveBeenCalledWith('/checkin/recent', { limit: 10, max_id: undefined });
  });

  it('checkin_info hits the view path', async () => {
    get.mockResolvedValueOnce({ checkin: {} });
    await harness.callTool('untappd_checkin_info', { checkin_id: 1583983210 });
    expect(get).toHaveBeenCalledWith('/checkin/view/1583983210');
  });

  it('user_wishlist compact projects to slim beers', async () => {
    get.mockResolvedValueOnce({ beers: { items: [{ created_at: 'd', beer: { bid: 5, beer_name: 'W', beer_style: 'Lager' }, brewery: { brewery_name: 'Br' } }] } });
    const r = await harness.callTool('untappd_user_wishlist', { username: 'x', compact: true });
    const item = (parse(r as never).beers as any).items[0];
    expect(item).toMatchObject({ bid: 5, name: 'W', added_at: 'd' });
    expect(item.beer).toBeUndefined();
  });

  it('user_beers compact projects to slim beers', async () => {
    get.mockResolvedValueOnce({ beers: { items: [{ count: 2, beer: { bid: 6, beer_name: 'D' }, brewery: { brewery_name: 'Co' } }] } });
    const r = await harness.callTool('untappd_user_beers', { username: 'x', compact: true });
    const item = (parse(r as never).beers as any).items[0];
    expect(item).toMatchObject({ bid: 6, name: 'D', your_count: 2 });
  });

  it('user_venues hits /user/venues with an explicit username', async () => {
    get.mockResolvedValueOnce({ venues: {} });
    await harness.callTool('untappd_user_venues', { username: 'someone', sort: 'checkin' });
    expect(get).toHaveBeenCalledWith('/user/venues/someone', { limit: undefined, offset: undefined, sort: 'checkin' });
  });

  it('venue_by_foursquare hits the foursquare_lookup path (url-encoded)', async () => {
    get.mockResolvedValueOnce({ venue: {} });
    await harness.callTool('untappd_venue_by_foursquare', { foursquare_id: 'abc 123' });
    expect(get).toHaveBeenCalledWith('/venue/foursquare_lookup/abc%20123');
  });

  it('beer_activity hits /beer/checkins with paging', async () => {
    get.mockResolvedValueOnce({ checkins: { items: [] } });
    await harness.callTool('untappd_beer_activity', { bid: 4499, limit: 5, max_id: 42 });
    expect(get).toHaveBeenCalledWith('/beer/checkins/4499', { limit: 5, max_id: 42 });
  });

  it('venue_activity hits /venue/checkins', async () => {
    get.mockResolvedValueOnce({ checkins: { items: [] } });
    await harness.callTool('untappd_venue_activity', { venue_id: 100 });
    expect(get).toHaveBeenCalledWith('/venue/checkins/100', { limit: undefined, max_id: undefined });
  });

  it('brewery_beers hits /brewery/beer_list', async () => {
    get.mockResolvedValueOnce({ beers: {} });
    await harness.callTool('untappd_brewery_beers', { brewery_id: 5143, sort: 'rating' });
    expect(get).toHaveBeenCalledWith('/brewery/beer_list/5143', { limit: undefined, offset: undefined, sort: 'rating' });
  });

  it('trending calls /beer/trending', async () => {
    get.mockResolvedValueOnce({ macro: {}, micro: {} });
    await harness.callTool('untappd_trending', {});
    expect(get).toHaveBeenCalledWith('/beer/trending');
  });

  it('notifications calls /notifications', async () => {
    get.mockResolvedValueOnce({ notifications: {} });
    await harness.callTool('untappd_notifications', { limit: 10 });
    expect(get).toHaveBeenCalledWith('/notifications', { limit: 10, offset: undefined });
  });

  it('local_checkins passes lat/lng/radius to /thepub/local', async () => {
    get.mockResolvedValueOnce({ checkins: { items: [] } });
    await harness.callTool('untappd_local_checkins', { lat: 40.7, lng: -74, radius: 10 });
    expect(get).toHaveBeenCalledWith('/thepub/local', { lat: 40.7, lng: -74, limit: undefined, radius: 10 });
  });

  // compact wiring is live for every check-in feed tool (not just search_beer):
  // a fat checkin must come back slimmed when compact: true.
  const FEED_COMPACT: [string, Record<string, unknown>][] = [
    ['untappd_user_checkins', { username: 'someone' }],
    ['untappd_activity_feed', {}],
    ['untappd_beer_activity', { bid: 1 }],
    ['untappd_venue_activity', { venue_id: 1 }],
    ['untappd_local_checkins', { lat: 1, lng: 2 }],
  ];
  for (const [tool, args] of FEED_COMPACT) {
    it(`${tool} applies the compact projection`, async () => {
      get.mockResolvedValueOnce({
        checkins: { items: [{ checkin_id: 7, beer: { bid: 3, beer_name: 'X', beer_style: 'IPA' }, user: { user_name: 'u' } }] },
      });
      const r = await harness.callTool(tool, { ...args, compact: true });
      const item = ((parse(r as never).checkins as { items: Record<string, unknown>[] }).items)[0];
      expect(item).toMatchObject({ checkin_id: 7, user: 'u', beer: { bid: 3, name: 'X', style: 'IPA' } });
      expect(item.beer_name).toBeUndefined(); // proves it was projected, not raw
    });
  }
});
