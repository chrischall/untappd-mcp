import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, createHelpfulError } from '@chrischall/mcp-utils';

export interface ResolvedUrl {
  type: 'beer' | 'brewery' | 'venue' | 'user' | 'checkin';
  /** The numeric id (beer/brewery/venue/checkin) when applicable. */
  id?: number;
  /** The username (user / checkin URLs). */
  username?: string;
  /** The tool to call next with this result. */
  tool: string;
}

/**
 * Parse an untappd.com URL into its entity type and id. Path shapes (confirmed
 * from the app + site):
 *   /b/<slug>/<bid>              → beer
 *   /w/<slug>/<brewery_id>       → brewery
 *   /v/<slug>/<venue_id>         → venue
 *   /user/<username>             → user
 *   /user/<username>/checkin/<id>→ checkin
 * Returns null if the URL isn't a recognised Untappd entity URL.
 */
export function parseUntappdUrl(input: string): ResolvedUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)untappd\.com$/i.test(url.hostname)) return null;
  const segs = url.pathname.split('/').filter(Boolean);

  // /user/<username>/checkin/<id>
  if (segs[0] === 'user' && segs[2] === 'checkin' && /^\d+$/.test(segs[3] ?? '')) {
    return { type: 'checkin', id: Number(segs[3]), username: segs[1], tool: 'untappd_checkin_info' };
  }
  // /user/<username>
  if (segs[0] === 'user' && segs[1]) {
    return { type: 'user', username: segs[1], tool: 'untappd_user_info' };
  }
  const short: Record<string, { type: ResolvedUrl['type']; tool: string }> = {
    b: { type: 'beer', tool: 'untappd_beer_info' },
    w: { type: 'brewery', tool: 'untappd_brewery_info' },
    v: { type: 'venue', tool: 'untappd_venue_info' },
  };
  // /b|w|v/<slug>/<id>  (id is the last numeric segment)
  if (segs[0] && short[segs[0]]) {
    const last = segs[segs.length - 1];
    if (/^\d+$/.test(last)) {
      return { ...short[segs[0]], id: Number(last) };
    }
  }
  return null;
}

export function registerResolveTools(server: McpServer): void {
  server.registerTool(
    'untappd_resolve',
    {
      title: 'Resolve an Untappd URL',
      description:
        'Parse an untappd.com URL (a beer /b/, brewery /w/, venue /v/, user /user/, or check-in link) into its ' +
        'entity type and id, and name the tool to call next. Pure local parsing — no network. Read-only.',
      annotations: toolAnnotations({ title: 'Resolve an Untappd URL', readOnly: true, idempotent: true, openWorld: false }),
      inputSchema: {
        url: z.string().min(1).describe('An untappd.com URL to resolve'),
      },
    },
    async ({ url }) => {
      const resolved = parseUntappdUrl(url);
      if (!resolved) {
        throw createHelpfulError(`Not a recognised Untappd entity URL: ${url}`, {
          hint: 'Expected an untappd.com link like /b/<slug>/<bid>, /w/<slug>/<id>, /v/<slug>/<id>, or /user/<name>.',
        });
      }
      return textResult(resolved);
    },
  );
}
