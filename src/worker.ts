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
  ],
});

// The Durable Object binding (`wrangler.jsonc`'s `MCP_OBJECT` → `UntappdMcpAgent`)
// resolves this named export.
export { Agent as UntappdMcpAgent };

export default handler;
