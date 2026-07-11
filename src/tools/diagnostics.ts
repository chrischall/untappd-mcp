import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Small helpers so the live build's exact toolset is visible from the client
// (via untappd_healthcheck) and from server logs (a startup line). This is how
// you confirm a deploy actually shipped the tools you expect — e.g. that the
// remote connector is exposing the cache tools, not a stale 37-tool build.

/** The names of every tool registered on `server`, sorted. Defensive if the SDK internal shape drifts. */
export function registeredToolNames(server: McpServer): string[] {
  const reg = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return reg ? Object.keys(reg).sort() : [];
}

/**
 * FNV-1a 32-bit hash of the sorted tool-name list — a stable, dependency-free
 * fingerprint of the exposed toolset (works in both Node and Workers), so two
 * builds can be compared at a glance without diffing the full list.
 */
export function toolsHash(names: string[]): string {
  let h = 0x811c9dc5;
  const s = names.join(',');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Version + tool count + tool-name-hash + names, for the healthcheck payload. */
export function toolInventory(server: McpServer): { tool_count: number; tools_hash: string; tools: string[] } {
  const names = registeredToolNames(server);
  return { tool_count: names.length, tools_hash: toolsHash(names), tools: names };
}

/** Emit a one-line startup log of the registered tools (stderr on Node, logs on Workers). */
export function logRegisteredTools(server: McpServer, context: string): void {
  const names = registeredToolNames(server);
  console.error(`[untappd-mcp] ${context}: ${names.length} tools registered [${toolsHash(names)}]: ${names.join(', ')}`);
}
