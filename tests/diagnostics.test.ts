import { describe, it, expect, afterAll } from 'vitest';
import { UntappdClient } from '../src/client.js';
import { VERSION } from '../src/version.js';
import { CheckinCache } from '../src/cache/db.js';
import { toolsHash } from '../src/tools/diagnostics.js';
import { registerBeerTools } from '../src/tools/beer.js';
import { registerBreweryTools } from '../src/tools/brewery.js';
import { registerVenueTools } from '../src/tools/venue.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerFeedTools } from '../src/tools/feed.js';
import { registerResolveTools } from '../src/tools/resolve.js';
import { registerDiscoverTools } from '../src/tools/discover.js';
import { registerFriendActionTools } from '../src/tools/friends.js';
import { registerWishlistTools } from '../src/tools/wishlist.js';
import { registerCheckinTools } from '../src/tools/checkin.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { registerCacheTools } from '../src/tools/cache.js';
import { createTestHarness } from './helpers.js';

const CACHE_TOOLS = [
  'untappd_sync_checkins',
  'untappd_sync_user_beers',
  'untappd_cache_has_had',
  'untappd_cache_has_had_many',
  'untappd_cache_not_had',
  'untappd_cache_query',
  'untappd_top_not_had',
];

describe('healthcheck build diagnostics', () => {
  const client = new UntappdClient();
  const cache = CheckinCache.open(':memory:');
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  afterAll(async () => {
    if (harness) await harness.close();
  });

  function parse(r: unknown): Record<string, unknown> {
    return JSON.parse((r as { content: { text: string }[] }).content[0].text);
  }

  it('reports version, tool count, a stable hash, and the exact tool names', async () => {
    harness = await createTestHarness((server) => {
      registerBeerTools(server, client);
      registerBreweryTools(server, client);
      registerVenueTools(server, client);
      registerUserTools(server, client);
      registerFeedTools(server, client);
      registerResolveTools(server, client);
      registerDiscoverTools(server, client);
      registerFriendActionTools(server, client);
      registerWishlistTools(server, client);
      registerCheckinTools(server, client);
      registerUtilityTools(server, client);
      registerCacheTools(server, client, () => cache);
    });

    const out = parse(await harness.callTool('untappd_healthcheck', {}));
    expect(out.server_version).toBe(VERSION);

    const tools = out.tools as string[];
    // The full toolset (incl. the 7 cache tools) is registered — this is the
    // 44-tool set the remote connector must also expose.
    expect(tools.length).toBe(44);
    expect(out.tool_count).toBe(44);
    for (const name of CACHE_TOOLS) expect(tools).toContain(name);

    // The hash is the FNV-1a of the sorted names — stable and self-consistent.
    expect(out.tools_hash).toBe(toolsHash(tools));
    expect(out.tools_hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
