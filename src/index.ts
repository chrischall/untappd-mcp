#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { registerBeerTools } from './tools/beer.js';
import { registerBreweryTools } from './tools/brewery.js';
import { registerVenueTools } from './tools/venue.js';
import { registerUserTools } from './tools/user.js';
import { registerFeedTools } from './tools/feed.js';
import { registerDiscoverTools } from './tools/discover.js';
import { registerWishlistTools } from './tools/wishlist.js';
import { registerCheckinTools } from './tools/checkin.js';
import { registerUtilityTools } from './tools/utilities.js';

// The Untappd client is a module-level singleton (imported by each tool module)
// that defers its config error to the first request. That preserves the
// deferred-config-error pattern: the server boots and answers the host's
// install-time tools/list smoke test even when credentials are absent — the
// configuration error only surfaces on the first tool call.
await runMcp({
  name: 'untappd-mcp',
  version: VERSION,
  banner:
    '[untappd-mcp] This project was developed and is maintained by AI (Claude Opus 4.8). Use at your own discretion.',
  tools: [
    registerBeerTools,
    registerBreweryTools,
    registerVenueTools,
    registerUserTools,
    registerFeedTools,
    registerDiscoverTools,
    registerWishlistTools,
    registerCheckinTools,
    registerUtilityTools,
  ],
});
