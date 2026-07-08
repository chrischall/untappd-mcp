import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { registerBeerTools } from '../../src/tools/beer.js';
import { registerBreweryTools } from '../../src/tools/brewery.js';
import { registerVenueTools } from '../../src/tools/venue.js';
import { registerUserTools } from '../../src/tools/user.js';
import { registerFeedTools } from '../../src/tools/feed.js';
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
      registerUtilityTools(server);
    });
  });

  it('search_beer maps query to q and passes paging', async () => {
    get.mockResolvedValueOnce({ beers: { items: [] } });
    await harness.callTool('untappd_search_beer', { query: 'pliny', limit: 5, offset: 10 });
    expect(get).toHaveBeenCalledWith('/search/beer', { q: 'pliny', limit: 5, offset: 10, sort: undefined });
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
    // In the test env UNTAPPD_USERNAME is unset, so client.loginName is null.
    const r = await harness.callTool('untappd_user_wishlist', {});
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
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
});
