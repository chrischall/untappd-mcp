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

// Build the env-based client once and inject it into each registrar. The
// constructor defers its config error, so the server still boots (and answers
// the host's install-time tools/list probe) when credentials are absent.
const client = new UntappdClient();

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
    // Cache tools live only on the Node/stdio server: they need a local SQLite
    // file, which the filesystem-less Cloudflare Worker (src/worker.ts) can't
    // provide, so they are intentionally NOT registered there.
    (s) => registerCacheTools(s, client),
  ],
});
