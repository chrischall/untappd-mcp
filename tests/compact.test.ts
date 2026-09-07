import { describe, it, expect, vi } from 'vitest';
import {
  compactCheckin,
  compactBeerResult,
  compactCheckins,
  compactBeerSearch,
  compactWishlistBeer,
  compactUserBeer,
  compactBreweryBeer,
  compactBreweryBeers,
} from '../src/compact.js';

describe('compact projections', () => {
  it('slims a check-in to the useful fields', () => {
    const raw = {
      checkin_id: 1,
      created_at: 'now',
      rating_score: 4.5,
      checkin_comment: 'great',
      user: { user_name: 'chris', bio: 'x'.repeat(500) },
      beer: { bid: 42, beer_name: 'IPA', beer_style: 'IPA', beer_abv: 6.5, beer_description: 'y'.repeat(500) },
      brewery: { brewery_name: 'ACME', contact: {} },
      venue: { venue_name: 'Bar' },
      toasts: { total_count: 3, items: [1, 2, 3] },
      comments: { count: 1, items: [{}] },
      media: { count: 2, items: [{}, {}] },
    };
    const c = compactCheckin(raw);
    expect(c).toEqual({
      checkin_id: 1,
      created_at: 'now',
      user: 'chris',
      rating: 4.5,
      comment: 'great',
      beer: { bid: 42, name: 'IPA', style: 'IPA', abv: 6.5 },
      brewery: 'ACME',
      venue: 'Bar',
      toasts: 3,
      comments: 1,
      has_photo: true,
    });
    // and much smaller than the raw record
    expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify(raw).length / 3);
  });

  it('slims a beer search item', () => {
    const raw = { checkin_count: 100, have_had: false, your_count: 0, beer: { bid: 7, beer_name: 'Stout', beer_style: 'Stout', beer_abv: 5, beer_ibu: 30, beer_description: 'z'.repeat(400) }, brewery: { brewery_name: 'B' } };
    expect(compactBeerResult(raw)).toEqual({ bid: 7, name: 'Stout', style: 'Stout', abv: 5, ibu: 30, brewery: 'B', checkin_count: 100, have_had: false });
  });

  it('slims a wishlist item (keeps the added-at date)', () => {
    const raw = { created_at: 'yesterday', beer: { bid: 5, beer_name: 'W', beer_style: 'Lager', beer_abv: 4, beer_description: 'x'.repeat(300) }, brewery: { brewery_name: 'Br' }, friends: { items: [] } };
    expect(compactWishlistBeer(raw)).toEqual({ bid: 5, name: 'W', style: 'Lager', abv: 4, ibu: undefined, brewery: 'Br', added_at: 'yesterday' });
  });

  it('slims a distinct-beers item (your count, ratings, last had)', () => {
    const raw = { count: 3, rating_score: 3.9, user_auth_rating_score: 4.25, recent_created_at: 'last week', first_had: 't', beer: { bid: 8, beer_name: 'D', beer_style: 'Porter', beer_abv: 5.5 }, brewery: { brewery_name: 'Co' } };
    expect(compactUserBeer(raw)).toEqual({ bid: 8, name: 'D', style: 'Porter', abv: 5.5, ibu: undefined, brewery: 'Co', your_count: 3, your_rating: 4.25, global_rating: 3.9, last_had: 'last week' });
  });

  it('projects the checkins.items array in place, keeping pagination', () => {
    const resp = { checkins: { count: 1, pagination: { max_id: 9 }, items: [{ checkin_id: 1, beer: { bid: 2, beer_name: 'X' } }] } };
    const out = compactCheckins(resp) as typeof resp;
    expect(out.checkins.pagination).toEqual({ max_id: 9 });
    expect(out.checkins.items[0]).toMatchObject({ checkin_id: 1, beer: { bid: 2, name: 'X' } });
  });

  it('returns the raw response (with a warning) when the shape drifted', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const drifted = { unexpected: true };
    expect(compactCheckins(drifted)).toBe(drifted);
    expect(compactBeerSearch({ beers: { notItems: [] } })).toEqual({ beers: { notItems: [] } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// `/brewery/beer_list/` — captured live from brewery 1142 (Sierra Nevada) and
// trimmed to the keys under test. This capture is the whole point of the
// exercise: the item IS `{beer:{…}, brewery:{…}}`-wrapped, so `beerCore` fits,
// but the two fields `compactBeerResult` adds on top of it — `checkin_count`
// and `have_had` — are NOT what this endpoint calls them. It says `total_count`
// and `has_had`. Reusing the search projector here would have produced a page
// of records with two silent `undefined`s, which is exactly the failure the
// fleet's projection rules exist to prevent and which `projectItems`' drift
// guard cannot catch (it only fires when the CONTAINER is missing).
const BEER_LIST = {
  total_count: 723,
  beers: {
    count: 1,
    items: [
      {
        total_user_count: 2,
        has_had: true,
        total_count: 1303919,
        beer: {
          bid: 6284,
          beer_name: 'Pale Ale',
          beer_label: 'https://assets.untappd.com/site/beer_logos/beer-6284_5418f_sm.jpeg',
          beer_style: 'Pale Ale - American',
          beer_abv: 5.6,
          beer_ibu: 38,
          beer_slug: 'sierra-nevada-brewing-co-pale-ale',
          beer_description: 'z'.repeat(400),
          is_in_production: 1,
          created_at: 'Thu, 07 Oct 2010 10:23:34 +0000',
          rating_score: 3.62,
          rating_count: 550296,
          on_list: false,
        },
        brewery: {
          brewery_id: 1142,
          brewery_name: 'Sierra Nevada Brewing Co.',
          brewery_label: 'https://assets.untappd.com/site/brewery_logos/brewery-1142_ddcfe.jpeg',
          contact: { twitter: 'SierraNevada', url: 'https://sierranevada.com' },
          location: { brewery_city: 'Chico', brewery_state: 'CA' },
        },
        friends: [],
      },
    ],
  },
  sorting_options: [
    { sort_key: 'most_popular', sort_name: 'Most Popular' },
    { sort_key: 'highest_abv', sort_name: 'ABV (High to Low)' },
  ],
};

describe('brewery beer-list projection', () => {
  it('reads the count and has-had fields this endpoint actually uses', () => {
    const c = compactBreweryBeer(BEER_LIST.beers.items[0]);
    expect(c).toEqual({
      bid: 6284,
      name: 'Pale Ale',
      style: 'Pale Ale - American',
      abv: 5.6,
      ibu: 38,
      brewery: 'Sierra Nevada Brewing Co.',
      rating: 3.62,
      rating_count: 550296,
      checkin_count: 1303919,
      have_had: true,
      your_count: 2,
    });
  });

  // The regression this projector exists to avoid. If someone later "simplifies"
  // it to `compactBeerResult`, these two go undefined and the page still looks
  // plausible — a beer with no check-ins that you have never had.
  it('would lose both counts under the search projector', () => {
    const wrong = compactBeerResult(BEER_LIST.beers.items[0]);
    expect(wrong.checkin_count).toBeUndefined();
    expect(wrong.have_had).toBeUndefined();
  });

  it('drops the per-item brewery block, the label URLs and the description', () => {
    const out = JSON.stringify(compactBreweryBeers(BEER_LIST));
    expect(out).not.toContain('beer_label');
    expect(out).not.toContain('brewery_label');
    expect(out).not.toContain('beer_description');
    expect(out).not.toContain('sierranevada.com');
    // the brewery NAME survives — only the repeated object goes
    expect(out).toContain('Sierra Nevada Brewing Co.');
  });

  // 16 UI sort options ride along on every page, and `sort` is already a closed
  // enum on the tool's own input schema — the caller cannot learn anything from
  // them they were not already told.
  it('drops sorting_options but keeps the paging counts', () => {
    const out = compactBreweryBeers(BEER_LIST) as Record<string, unknown>;
    expect(out.sorting_options).toBeUndefined();
    expect(out.total_count).toBe(723);
    expect((out.beers as Record<string, unknown>).count).toBe(1);
  });

  it('returns the raw response when beers.items is missing', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const raw = { beers: {} };
    expect(compactBreweryBeers(raw)).toBe(raw);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
