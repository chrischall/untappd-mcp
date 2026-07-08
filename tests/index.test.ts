import { describe, it, expect, afterAll } from 'vitest';
import { registerBeerTools } from '../src/tools/beer.js';
import { registerBreweryTools } from '../src/tools/brewery.js';
import { registerVenueTools } from '../src/tools/venue.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerFeedTools } from '../src/tools/feed.js';
import { registerResolveTools } from '../src/tools/resolve.js';
import { registerDiscoverTools } from '../src/tools/discover.js';
import { registerWishlistTools } from '../src/tools/wishlist.js';
import { registerFriendActionTools } from '../src/tools/friends.js';
import { registerCheckinTools } from '../src/tools/checkin.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { createTestHarness } from './helpers.js';

// Register every tool on an McpServer and verify the full roster via a client.
describe('tool registry', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('includes all 37 expected tools', async () => {
    harness = await createTestHarness((server) => {
      registerBeerTools(server);
      registerBreweryTools(server);
      registerVenueTools(server);
      registerUserTools(server);
      registerFeedTools(server);
      registerResolveTools(server);
      registerDiscoverTools(server);
      registerWishlistTools(server);
      registerFriendActionTools(server);
      registerCheckinTools(server);
      registerUtilityTools(server);
    });

    const tools = await harness.listTools();
    const allNames = tools.map((t) => t.name).sort();

    const expected = [
      'untappd_search_beer',
      'untappd_beer_info',
      'untappd_beer_activity',
      'untappd_search_brewery',
      'untappd_brewery_info',
      'untappd_brewery_beers',
      'untappd_search_venue',
      'untappd_venue_info',
      'untappd_venue_activity',
      'untappd_venue_by_foursquare',
      'untappd_user_info',
      'untappd_user_checkins',
      'untappd_user_wishlist',
      'untappd_user_beers',
      'untappd_user_badges',
      'untappd_user_friends',
      'untappd_user_venues',
      'untappd_pending_friends',
      'untappd_add_friend',
      'untappd_accept_friend',
      'untappd_reject_friend',
      'untappd_remove_friend',
      'untappd_activity_feed',
      'untappd_checkin_info',
      'untappd_resolve',
      'untappd_open_url',
      'untappd_trending',
      'untappd_notifications',
      'untappd_local_checkins',
      'untappd_toast',
      'untappd_add_comment',
      'untappd_delete_comment',
      'untappd_checkin',
      'untappd_delete_checkin',
      'untappd_wishlist_add',
      'untappd_wishlist_remove',
      'untappd_healthcheck',
    ].sort();

    expect(allNames).toEqual(expected);
    expect(tools).toHaveLength(37);
  });
});
