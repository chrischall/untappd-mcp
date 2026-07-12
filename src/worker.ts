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
import { UntappdCacheDO, durableCacheProvider } from './cache/durable.js';
import type { CacheStore } from './cache/store.js';

// Capture the Worker `env` (bindings) + operator username per client instance.
// We set this in `buildClient` — which the connector ALWAYS calls with `env`
// (the API tools depend on it) — and read it back in the cache registrar, keyed
// by the exact client instance so concurrent user sessions never cross wires.
// Deliberately NOT threaded through a registrar context argument: that would
// depend on the connector build forwarding it, and a stale bundle silently
// dropping it is what made every cache tool throw
// "Cannot read properties of undefined (reading 'env')".
const cacheContext = new WeakMap<UntappdClient, { env: { CACHE_DO?: DurableObjectNamespace<UntappdCacheDO> }; username: string }>();

// The Cloudflare remote-connector entrypoint: wires the same tool registrars
// the stdio server uses (`src/index.ts`) into `@chrischall/mcp-connector`'s
// generic OAuth + McpAgent harness, with Untappd's own xauth login
// (`src/untappd-auth.ts`) and a per-user `UntappdClient` built from the
// stored OAuth props plus the Worker's app-level credentials.
const { Agent, handler } = createConnector<UntappdProps, UntappdClient>({
  name: 'untappd-mcp',
  version: VERSION,
  auth: untappdAuth,
  buildClient: (props, env) => {
    const client = new UntappdClient({
      token: props.token,
      clientId: env.UNTAPPD_CLIENT_ID,
      clientSecret: env.UNTAPPD_CLIENT_SECRET,
      loginName: props.username,
    });
    if (!env?.CACHE_DO) {
      console.error(
        '[untappd-mcp] worker: CACHE_DO Durable Object binding is missing — cache tools will error until it is declared in wrangler.jsonc and redeployed.',
      );
    }
    cacheContext.set(client, { env, username: props.username });
    return client;
  },
  tools: [
    // The cache tools need durable per-user storage, and the beer tools seed the
    // beer-metadata cache — both use the operator's cache DO, resolved from the
    // WeakMap set in buildClient (keyed by the client so sessions never cross).
    (server, client) => registerBeerTools(server, client, providerFor(client)),
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
    (server, client) => registerCacheTools(server, client, providerFor(client)),
    // Keep last: logs the full registered toolset (count + names) at startup.
    (server) => logRegisteredTools(server, 'worker'),
  ],
});

/** The operator's Durable Object cache-store provider for a given client instance. */
function providerFor(client: UntappdClient): () => CacheStore {
  const cx = cacheContext.get(client);
  return durableCacheProvider(cx?.env?.CACHE_DO, cx?.username);
}

// The Durable Object binding (`wrangler.jsonc`'s `MCP_OBJECT` → `UntappdMcpAgent`)
// resolves this named export.
export { Agent as UntappdMcpAgent };

// The per-user check-in cache Durable Object (`wrangler.jsonc`'s `CACHE_DO` →
// `UntappdCacheDO`). Exported so the runtime can resolve the class.
export { UntappdCacheDO };

export default handler;
