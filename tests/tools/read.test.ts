import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerBeerTools } from '../../src/tools/beer.js';
import { registerBreweryTools } from '../../src/tools/brewery.js';
import { registerVenueTools } from '../../src/tools/venue.js';
import { registerUserTools } from '../../src/tools/user.js';
import { registerFeedTools } from '../../src/tools/feed.js';
import { registerDiscoverTools } from '../../src/tools/discover.js';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { createTestHarness } from '../helpers.js';

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
      registerBeerTools(server);
      registerBreweryTools(server);
      registerVenueTools(server);
      registerUserTools(server);
      registerFeedTools(server);
      registerDiscoverTools(server);
      registerUtilityTools(server);
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
});
