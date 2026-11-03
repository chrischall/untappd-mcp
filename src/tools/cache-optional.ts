import type { CacheStore } from '../cache/store.js';

/**
 * Wrap an optional cache provider for tools whose cache is an optimisation, not
 * their answer: no provider, or a cache that fails to open, means "call the API"
 * (with one stderr note) rather than failing the read.
 */
export function optionalCache(provider?: () => CacheStore): () => CacheStore | undefined {
  let warned = false;
  return () => {
    if (!provider) return undefined;
    try {
      return provider();
    } catch (e) {
      if (!warned) {
        warned = true;
        console.error(`[untappd-mcp] response cache unavailable, calling Untappd directly: ${(e as Error)?.message ?? e}`);
      }
      return undefined;
    }
  };
}
