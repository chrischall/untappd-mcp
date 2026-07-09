// Stub for the `ai` (Vercel AI SDK) package, aliased in `wrangler.jsonc`'s
// `alias` map.
//
// The `agents` package (our `@chrischall/mcp-connector` dependency) bundles
// both its server-side `McpAgent` (all we use, via `agents/mcp`) and
// unrelated AI-chat client helpers (`getAITools()`, `AIChatAgent`, the React
// hooks) in the same shared chunk. Those helpers lazily `import("ai")` for
// converting tool schemas in an AI SDK chat UI — functionality this
// server-only MCP connector never calls. Without a real `ai` install,
// esbuild's static analysis (used by `wrangler deploy`/`wrangler dev` to
// bundle the Worker) fails to resolve that specifier even though the code
// path is unreachable here, so we alias it to this inert stub instead of
// pulling in the full AI SDK as a real dependency. If any of these are ever
// actually invoked, this throws immediately rather than doing the wrong thing
// silently.
function unsupported(name: string): never {
  throw new Error(
    `[untappd-mcp] "${name}" from the "ai" package is not supported — this Worker only uses agents/mcp's McpAgent, not the AI-chat client helpers.`,
  );
}

export function jsonSchema(..._args: unknown[]): unknown {
  return unsupported('jsonSchema');
}

export function tool(..._args: unknown[]): unknown {
  return unsupported('tool');
}

export function getToolName(..._args: unknown[]): unknown {
  return unsupported('getToolName');
}

export function isToolUIPart(..._args: unknown[]): unknown {
  return unsupported('isToolUIPart');
}

export function parsePartialJson(..._args: unknown[]): unknown {
  return unsupported('parsePartialJson');
}

export class DefaultChatTransport {
  constructor(..._args: unknown[]) {
    unsupported('DefaultChatTransport');
  }
}
