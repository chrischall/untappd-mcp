import type { ServerContext } from '@modelcontextprotocol/server';
import { confirmationFromEnv, requireConfirmationWithFallback } from '@chrischall/mcp-utils';

/** The sentence every gated write's description carries. */
export const CONFIRM_FLOW =
  'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call ' +
  'returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).';

export interface WriteConfirmation {
  /** Tool name the token is bound to. */
  tool: string;
  /** `untappd.<verb>`. */
  action: string;
  /** Prompt shown above the preview. */
  message: string;
  /** The phase-2 token from the tool's input, or undefined on phase 1. */
  confirmToken: string | undefined;
  /** The primary id acted on. */
  target: string | number;
  /** Exactly what the write will send — hashed into the token. */
  payload: unknown;
  /** What the user sees (the elicitation details, or the phase-1 preview). */
  preview: Record<string, unknown>;
}

/**
 * Gate a write behind the fleet confirmation flow. `undefined` means proceed;
 * anything else is the result to return unchanged. Callers rebuild `payload`
 * and `preview` from the arguments on every call, so a token only authorises
 * the exact request its preview showed.
 */
export function confirmWrite(ctx: ServerContext, c: WriteConfirmation) {
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: c.action,
      message: c.message,
      details: c.preview,
      tool: c.tool,
      confirmToken: c.confirmToken,
      subject: () => ({ target: String(c.target), payload: c.payload, preview: c.preview }),
    }),
  );
}
