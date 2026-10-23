import { describe, it, expect, afterEach } from 'vitest';
import { RateLimitError } from '@chrischall/mcp-utils';
import { CheckinCache } from '../src/cache/db.js';
import { normalizeLine, rankCandidates, candidateFromSearch, searchQueries } from '../src/menu/match.js';
import { registerMenuTools, parseVenueArg } from '../src/tools/menu.js';
import type { UntappdClient } from '../src/client.js';
import { createTestHarness } from './helpers.js';
import { BEER_INFO, BLACK_ABBEY_BEERS, SEARCH_BEER, SEARCH_BREWERY } from './fixtures/untappd-live.js';

// ── fakes ──

interface UserBeer {
  bid: number;
  name: string;
  count?: number;
  rating?: number;
  last?: string;
}

function userBeerItem(b: UserBeer): unknown {
  return {
    count: b.count ?? 1,
    user_rating_score: b.rating ?? 0,
    first_created_at: 'Wed, 10 Feb 2016 12:00:00 +0000',
    recent_created_at: b.last ?? 'Sat, 05 Jul 2025 18:23:11 +0000',
    beer: { bid: b.bid, beer_name: b.name, beer_style: 'IPA - American', beer_abv: 6 },
    brewery: { brewery_id: 1, brewery_name: 'X' },
  };
}

interface FakeOpts {
  userBeers?: UserBeer[];
  /** Answer 429 (with this Retry-After) the first time each listed path+query is requested. */
  rateLimitOnce?: Map<string, number | undefined>;
  venue?: unknown;
}

/** Routes the endpoints the pipeline uses to the live-captured fixtures. */
function fakeClient(opts: FakeOpts = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const limited = new Set<string>();
  const get = async (path: string, q: Record<string, unknown> = {}) => {
    const sig = `${path}${q.q !== undefined ? `?q=${String(q.q)}` : q.offset !== undefined ? `?offset=${String(q.offset)}` : ''}`;
    calls.push(sig);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2)); // let concurrent calls overlap
      if (opts.rateLimitOnce?.has(sig) && !limited.has(sig)) {
        limited.add(sig);
        throw new RateLimitError('Untappd', opts.rateLimitOnce.get(sig));
      }
      if (path.startsWith('/user/beers/')) {
        const all = (opts.userBeers ?? []).map(userBeerItem);
        const offset = Number(q.offset ?? 0);
        return { total_count: all.length, beers: { items: all.slice(offset, offset + 50) } };
      }
      if (path === '/search/beer') return { beers: { items: SEARCH_BEER[String(q.q)] ?? [] } };
      if (path === '/search/brewery') return { brewery: { items: SEARCH_BREWERY[String(q.q)] ?? [] } };
      if (path === '/brewery/beer_list/20035') return { beers: { items: BLACK_ABBEY_BEERS } };
      const info = path.match(/^\/beer\/info\/(\d+)$/);
      if (info) return { beer: BEER_INFO[Number(info[1])] ?? { bid: Number(info[1]) } };
      if (path.startsWith('/venue/info/')) return opts.venue ?? {};
      throw new Error(`unexpected ${path}`);
    } finally {
      inFlight--;
    }
  };
  const client = { get, get loginName() { return 'mer'; } } as unknown as UntappdClient;
  return { client, calls, maxInFlight: () => maxInFlight };
}

const MENU = [
  "HAP & HARRY'S TENNESSEE LAGER $6",
  'I BELIEVE IN NASHVILLE BLONDE',
  'JACKALOPE FENNARIO IPA 16oz 7.2%',
  'BEARDED IRIS HOMESTYLE',
  'BLACK ABBEY SEASONAL',
  'ROTATING DRAFT BEER',
  'ROTATING CIDER',
];

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const harnesses: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function setup(opts: FakeOpts = {}, cache = CheckinCache.open(':memory:')) {
  const fake = fakeClient(opts);
  const sleeps: number[] = [];
  const harness = await createTestHarness((server) =>
    registerMenuTools(server, fake.client, () => cache, { sleep: async (ms) => void sleeps.push(ms) }),
  );
  harnesses.push(harness);
  return { ...fake, harness, cache, sleeps };
}

// ── normalisation ──

describe('normalizeLine', () => {
  it('strips prices, sizes, ABV, punctuation and duplicated words', () => {
    expect(normalizeLine("HAP & HARRY'S TENNESSEE LAGER $6").tokens).toEqual(['hap', 'harrys', 'tennessee', 'lager']);
    expect(normalizeLine('Jackalope Fennario IPA IPA 16oz 7.2% $7.00').tokens).toEqual(['jackalope', 'fennario', 'ipa']);
    expect(normalizeLine('Bearded Iris — Homestyle (draft) 6/9').tokens).toEqual(['bearded', 'iris', 'homestyle']);
  });

  it('never turns "&" into "and" (live: "hap and harrys …" gets zero hits)', () => {
    expect(searchQueries(normalizeLine("HAP & HARRY'S TENNESSEE LAGER"))[0]).toBe('hap harrys tennessee lager');
  });

  it('classifies generic lines', () => {
    expect(normalizeLine('BLACK ABBEY SEASONAL')).toMatchObject({ kind: 'brewery_generic', breweryHint: 'black abbey' });
    expect(normalizeLine('Jackalope Rotating Tap')).toMatchObject({ kind: 'brewery_generic', breweryHint: 'jackalope' });
    expect(normalizeLine('ROTATING DRAFT BEER').kind).toBe('generic');
    expect(normalizeLine('ROTATING CIDER').kind).toBe('generic');
  });

  it('keeps a real beer whose name contains a generic word', () => {
    expect(normalizeLine('WIDMER ROTATOR IPA')).toMatchObject({ kind: 'beer', tokens: ['widmer', 'rotator', 'ipa'] });
    expect(normalizeLine('Guest Tap: Seasonal Saison')).toMatchObject({ kind: 'beer' });
  });

  it('falls back to a style-less query', () => {
    expect(searchQueries(normalizeLine('I BELIEVE IN NASHVILLE BLONDE'))).toEqual([
      'i believe in nashville blonde',
      'i believe in nashville',
    ]);
  });
});

// ── fuzzy resolution on the live search payloads ──

describe('candidate scoring (live search results)', () => {
  const best = (line: string, query: string, city?: string) =>
    rankCandidates(
      normalizeLine(line).tokens,
      SEARCH_BEER[query].map(candidateFromSearch).filter((c) => c !== null),
      city,
    )[0];

  it('HAP & HARRY\'S TENNESSEE LAGER → 304831, not the 3-check-in duplicate 6894790', () => {
    expect(best("HAP & HARRY'S TENNESSEE LAGER", 'hap harrys tennessee lager').bid).toBe(304831);
  });
  it('I BELIEVE IN NASHVILLE BLONDE → 3780741 (I Believe Brewing), not Hap & Harry\'s same-named beer', () => {
    expect(best('I BELIEVE IN NASHVILLE BLONDE', 'i believe in nashville').bid).toBe(3780741);
  });
  it('JACKALOPE FENNARIO IPA → 1893601', () => {
    expect(best('JACKALOPE FENNARIO IPA', 'jackalope fennario ipa').bid).toBe(1893601);
  });
  it('BEARDED IRIS HOMESTYLE → 1502190, not Double/Triple Homestyle', () => {
    expect(best('BEARDED IRIS HOMESTYLE', 'bearded iris homestyle').bid).toBe(1502190);
    // …while the menu naming the variant gets the variant.
    expect(best('BEARDED IRIS DOUBLE HOMESTYLE', 'bearded iris homestyle').bid).toBe(1942304);
  });
});

// ── the tool end to end ──

describe('untappd_menu_pick', () => {
  const HAS_HAD_FENNARIO: UserBeer[] = [{ bid: 1893601, name: 'Fennario', count: 3, rating: 3.75, last: 'Fri, 01 Aug 2025 20:00:00 +0000' }];

  it('resolves the menu, backfills an empty cache, and picks the top not-had beers', async () => {
    const { harness } = await setup({ userBeers: HAS_HAD_FENNARIO });
    const out = parse(await harness.callTool('untappd_menu_pick', { username: 'mer', items: MENU, venue_city: 'Nashville' }));

    expect(out.picks.map((p: { bid: number }) => p.bid)).toEqual([1502190, 3780741]);
    expect(out.picks[0]).toMatchObject({ item: 'BEARDED IRIS HOMESTYLE', name: 'Homestyle', brewery: 'Bearded Iris Brewing', global_rating: 3.98 });
    expect(out.picks[0].reason).toMatch(/not had · 3\.98 global rating · #1 of 3/);
    expect(out.not_had.map((b: { bid: number }) => b.bid).sort()).toEqual([304831, 1502190, 3780741].sort());
    expect(out.had).toEqual([
      expect.objectContaining({ item: 'JACKALOPE FENNARIO IPA 16oz 7.2%', bid: 1893601, count: 3, user_rating: 3.75 }),
    ]);
    expect(out.possible).toHaveLength(1);
    expect(out.possible[0]).toMatchObject({ item: 'BLACK ABBEY SEASONAL', brewery: 'The Black Abbey Brewing Company', needs_confirmation: true });
    const seasonal = out.possible[0].candidates.map((c: { name: string }) => c.name);
    expect(seasonal).toContain('Chronicles Festbier');
    expect(seasonal).not.toContain('The Rose');
    expect(out.unresolved).toEqual([
      { item: 'ROTATING DRAFT BEER', reason: 'ask bartender' },
      { item: 'ROTATING CIDER', reason: 'ask bartender' },
    ]);
    expect(out.sync).toMatchObject({ mode: 'backfill', coverage_complete: true, api_calls: 1 });
    expect(out.another_run_needed).toBe(false);
    expect(out.freshness.coverage_complete).toBe(true);
  });

  it('applies style_filter to the picks', async () => {
    const { harness } = await setup({ userBeers: HAS_HAD_FENNARIO });
    const out = parse(await harness.callTool('untappd_menu_pick', { username: 'mer', items: MENU, style_filter: 'ipa', top_n: 5 }));
    expect(out.picks.map((p: { bid: number }) => p.bid)).toEqual([1502190]); // Fennario is IPA too, but had
  });

  it('a repeat menu is answered from the resolution cache: no searches, one incremental sync page', async () => {
    const s = await setup({ userBeers: HAS_HAD_FENNARIO });
    await s.harness.callTool('untappd_menu_pick', { username: 'mer', items: MENU, venue_city: 'Nashville' });
    s.calls.length = 0;
    const out = parse(await s.harness.callTool('untappd_menu_pick', { username: 'mer', items: MENU, venue_city: 'Nashville' }));
    expect(s.calls).toEqual(['/user/beers/mer?offset=0']);
    expect(out.sync).toMatchObject({ mode: 'incremental', api_calls: 1, stopped_at_bid: 1893601 });
    expect(out.picks.map((p: { bid: number }) => p.bid)).toEqual([1502190, 3780741]);
    expect(out.api_calls).toBe(1);
  });

  it('runs searches at most 4 at a time', async () => {
    const s = await setup({ userBeers: [] });
    await s.harness.callTool('untappd_menu_pick', { username: 'mer', items: MENU.slice(0, 5) });
    expect(s.maxInFlight()).toBeLessThanOrEqual(4);
    expect(s.maxInFlight()).toBeGreaterThan(1);
  });

  it('backs off and retries a 429 on a search', async () => {
    const s = await setup({
      userBeers: [],
      rateLimitOnce: new Map([['/search/beer?q=jackalope fennario ipa', 1]]),
    });
    const out = parse(await s.harness.callTool('untappd_menu_pick', { username: 'mer', items: ['JACKALOPE FENNARIO IPA'] }));
    expect(s.sleeps).toEqual([1000]);
    expect(out.not_had[0].bid).toBe(1893601);
    // sync page + 429'd search + retried search + beer/info
    expect(out.api_calls).toBe(4);
  });

  it('stays inside api_budget and says another run is needed', async () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ bid: 9_000_000 + i, name: `B${i}` }));
    const s = await setup({ userBeers: big });
    const out = parse(await s.harness.callTool('untappd_menu_pick', { username: 'mer', items: MENU.slice(0, 4), api_budget: 6 }));
    expect(s.calls.length).toBeLessThanOrEqual(6);
    expect(out.api_calls).toBe(s.calls.length);
    expect(out.sync).toMatchObject({ mode: 'backfill', coverage_complete: false });
    expect(out.another_run_needed).toBe(true);
    expect(out.freshness.caveat).toMatch(/false negative/);
  });
});

describe('untappd_venue_pick', () => {
  const section = (id: number, items: Array<[number, string, string]>) => ({
    section_id: id,
    section_name: `Section ${id} `,
    items: items.map(([bid, name, style]) => ({ beer: { bid, beer_name: name, beer_style: style, beer_abv: 6 }, brewery: { brewery_name: 'Brewery' } })),
  });
  const venue = {
    venue: {
      venue_name: 'Test Taproom',
      location: { venue_city: 'Nashville' },
      verfied_beers: {
        total_count: 3,
        items: [{ menu: { menu_id: 1, menu_name: 'Draft', sections: { items: [section(1, [[1502190, 'Homestyle', 'IPA - New England / Hazy'], [1893601, 'Fennario', 'IPA - American']]), section(2, [[304831, 'Tennessee Lager', 'Lager - Pale']])] } } }],
      },
    },
  };

  it('pulls the whole menu, checks it against the cache and ranks the not-had beers', async () => {
    const s = await setup({ userBeers: [{ bid: 1893601, name: 'Fennario' }], venue });
    const out = parse(await s.harness.callTool('untappd_venue_pick', { venue: 'https://untappd.com/v/test-taproom/12345', username: 'mer' }));
    expect(s.calls[0]).toBe('/venue/info/12345');
    expect(out.venue).toMatchObject({ venue_id: 12345, name: 'Test Taproom', city: 'Nashville', menu_beers: 3, menu_complete: true });
    expect(out.picks.map((p: { bid: number }) => p.bid)).toEqual([1502190, 304831]);
    expect(out.had.map((h: { bid: number }) => h.bid)).toEqual([1893601]);
  });

  it('parses venue ids and URLs', () => {
    expect(parseVenueArg(42)).toBe(42);
    expect(parseVenueArg('42')).toBe(42);
    expect(parseVenueArg('https://untappd.com/v/the-black-abbey-brewing-company/1045667')).toBe(1045667);
    expect(() => parseVenueArg('https://untappd.com/b/x/1')).toThrow(/not an Untappd venue/);
  });
});
