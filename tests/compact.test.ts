import { describe, it, expect, vi } from 'vitest';
import { compactCheckin, compactBeerResult, compactCheckins, compactBeerSearch } from '../src/compact.js';

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
