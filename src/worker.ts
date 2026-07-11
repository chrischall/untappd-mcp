import { createConnector } from '@chrischall/mcp-connector';
import { VERSION } from './version.js';
import { UntappdClient } from './client.js';
import { untappdAuth, type UntappdProps } from './untappd-auth.js';
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
import { UntappdCacheDO, makeDurableCacheStore } from './cache/durable.js';

// The Cloudflare remote-connector entrypoint: wires the same tool registrars
// the stdio server uses (`src/index.ts`) into `@chrischall/mcp-connector`'s
// generic OAuth + McpAgent harness, with Untappd's own xauth login
// (`src/untappd-auth.ts`) and a per-user `UntappdClient` built from the
// stored OAuth props plus the Worker's app-level credentials.
const { Agent, handler } = createConnector<UntappdProps, UntappdClient>({
  name: 'untappd-mcp',
  version: VERSION,
  auth: untappdAuth,
  buildClient: (props, env) =>
    new UntappdClient({
      token: props.token,
      clientId: env.UNTAPPD_CLIENT_ID,
      clientSecret: env.UNTAPPD_CLIENT_SECRET,
      loginName: props.username,
    }),
  tools: [
    registerBeerTools,
    registerBreweryTools,
    registerVenueTools,
    registerUserTools,
    registerFeedTools,
    registerResolveTools,
    registerDiscoverTools,
    registerFriendActionTools,
    registerWishlistTools,
    registerCheckinTools,
    registerUtilityTools,
    // The cache tools need durable per-user storage. Back them with a dedicated
    // Durable Object keyed by the authenticated operator's username (so the
    // cache persists across that user's conversations — unlike the session-keyed
    // MCP agent DO). `ctx` carries the Worker `env` and the user's OAuth props.
    (server, client, ctx) =>
      registerCacheTools(server, client, () => makeDurableCacheStore(ctx.env.CACHE_DO, ctx.props.username)),
    // Keep last: logs the full registered toolset (count + names) at startup.
    (server) => logRegisteredTools(server, 'worker'),
  ],
});

// The Durable Object binding (`wrangler.jsonc`'s `MCP_OBJECT` → `UntappdMcpAgent`)
// resolves this named export.
export { Agent as UntappdMcpAgent };

// The per-user check-in cache Durable Object (`wrangler.jsonc`'s `CACHE_DO` →
// `UntappdCacheDO`). Exported so the runtime can resolve the class.
export { UntappdCacheDO };

export default handler;
