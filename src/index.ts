#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { UntappdClient } from './client.js';
import { registerBeerTools } from './tools/beer.js';
import { registerBreweryTools } from './tools/brewery.js';
import { registerVenueTools } from './tools/venue.js';
import { registerUserTools } from './tools/user.js';
import { registerFeedTools } from './tools/feed.js';
import { registerResolveTools } from './tools/resolve.js';
import { registerDiscoverTools } from './tools/discover.js';
import { registerFriendActionTools } from './tools/friends.js';
import { registerWishlistTools } from './tools/wishlist.js';
import { registerCheckinTools } from './tools/checkin.js';
import { registerUtilityTools } from './tools/utilities.js';
import { registerCacheTools } from './tools/cache.js';
import { logRegisteredTools } from './tools/diagnostics.js';
import { CheckinCache, defaultCachePath } from './cache/db.js';
import type { CacheStore } from './cache/store.js';

// Build the env-based client once and inject it into each registrar. The
// constructor defers its config error, so the server still boots (and answers
// the host's install-time tools/list probe) when credentials are absent.
const client = new UntappdClient();

// The stdio server backs the cache with a local `node:sqlite` file, opened lazily
// on first cache-tool use so the server still boots when no path is configured.
let nodeCache: CacheStore | undefined;
const nodeCacheProvider = (): CacheStore => (nodeCache ??= CheckinCache.open(defaultCachePath()));

await runMcp({
  name: 'untappd-mcp',
  version: VERSION,
  banner:
    '[untappd-mcp] This project was developed and is maintained by AI (Claude Opus 4.8). Use at your own discretion.',
  tools: [
    (s) => registerBeerTools(s, client),
    (s) => registerBreweryTools(s, client),
    (s) => registerVenueTools(s, client),
    (s) => registerUserTools(s, client),
    (s) => registerFeedTools(s, client),
    (s) => registerResolveTools(s, client),
    (s) => registerDiscoverTools(s, client),
    (s) => registerFriendActionTools(s, client),
    (s) => registerWishlistTools(s, client),
    (s) => registerCheckinTools(s, client),
    (s) => registerUtilityTools(s, client),
    // The stdio server backs the cache with a local `node:sqlite` file; the
    // remote Cloudflare connector (src/worker.ts) backs the same cache tools
    // with a per-user Durable Object instead.
    (s) => registerCacheTools(s, client, nodeCacheProvider),
    // Keep last: logs the full registered toolset (count + names) at startup.
    (s) => logRegisteredTools(s, 'stdio'),
  ],
});
