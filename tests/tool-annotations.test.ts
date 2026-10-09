import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { UntappdClient } from '../src/client.js';
import { registerBeerTools } from '../src/tools/beer.js';
import { registerBreweryTools } from '../src/tools/brewery.js';
import { registerVenueTools } from '../src/tools/venue.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerFeedTools } from '../src/tools/feed.js';
import { registerResolveTools } from '../src/tools/resolve.js';
import { registerDiscoverTools } from '../src/tools/discover.js';
import { registerFriendActionTools } from '../src/tools/friends.js';
import { registerWishlistTools } from '../src/tools/wishlist.js';
import { registerCheckinTools } from '../src/tools/checkin.js';
import { registerUtilityTools } from '../src/tools/utilities.js';
import { registerCacheTools } from '../src/tools/cache.js';

/**
 * Reads the REGISTERED config of every registrar `src/index.ts` wires up, so a
 * loop-registered tool (the four friend actions) is covered exactly like a
 * literal one — a `registerTool('<name>'` scan cannot see those, and they once
 * shipped unannotated because of it.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as never;
  const client = new UntappdClient();
  const cache = (() => {
    throw new Error('cache is never opened at registration time');
  }) as never;
  registerBeerTools(server, client, cache);
  registerBreweryTools(server, client);
  registerVenueTools(server, client);
  registerUserTools(server, client);
  registerFeedTools(server, client);
  registerResolveTools(server, client);
  registerDiscoverTools(server, client);
  registerFriendActionTools(server, client);
  registerWishlistTools(server, client);
  registerCheckinTools(server, client);
  registerUtilityTools(server, client);
  registerCacheTools(server, client, cache);
  return seen;
}

describe('tool annotations', () => {
  it('covers the full served surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(46);
  });

  it('sets an explicit boolean readOnlyHint and openWorldHint on every tool', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean' || typeof a?.openWorldHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  // destructiveHint DEFAULTS TO TRUE when readOnlyHint is false, so a write that
  // forgets it is indistinguishable from one that chose it.
  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every write that reaches another person destructive, even with a delete inverse', () => {
    // A check-in publishes to the public feed; a toast and a comment land in the
    // check-in owner's notifications (untappd_notifications lists "toasts,
    // comments, friend requests"). untappd_delete_checkin / untappd_delete_comment
    // / a second toast cannot un-notify anyone, so none of these has an inverse.
    const ann = registeredAnnotations();
    for (const name of [
      'untappd_checkin',
      'untappd_toast',
      'untappd_add_comment',
      'untappd_add_friend',
      'untappd_accept_friend',
      'untappd_reject_friend',
      'untappd_remove_friend',
    ]) {
      expect(ann[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it('keeps the wishlist pair additive — each is the other\'s inverse', () => {
    const ann = registeredAnnotations();
    for (const name of ['untappd_wishlist_add', 'untappd_wishlist_remove']) {
      expect(ann[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('holds the destructive set at its measured size', () => {
    const destructive = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual(
      [
        'untappd_accept_friend',
        'untappd_add_comment',
        'untappd_add_friend',
        'untappd_cache_forget',
        'untappd_checkin',
        'untappd_delete_checkin',
        'untappd_delete_comment',
        'untappd_reject_friend',
        'untappd_remove_friend',
        'untappd_toast',
      ].sort(),
    );
  });

  it('lists exactly the served tools in manifest.json tools[]', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      tools: { name: string }[];
    };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(Object.keys(registeredAnnotations()).sort());
  });
});
