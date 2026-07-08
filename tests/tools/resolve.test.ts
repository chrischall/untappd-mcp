import { describe, it, expect } from 'vitest';
import { parseUntappdUrl } from '../../src/tools/resolve.js';

describe('parseUntappdUrl', () => {
  it('parses a beer URL', () => {
    expect(parseUntappdUrl('https://untappd.com/b/russian-river-pliny-the-elder/4499')).toEqual({
      type: 'beer',
      id: 4499,
      tool: 'untappd_beer_info',
    });
  });

  it('parses a brewery URL', () => {
    expect(parseUntappdUrl('https://untappd.com/w/russian-river-brewing-company/5143')).toMatchObject({
      type: 'brewery',
      id: 5143,
      tool: 'untappd_brewery_info',
    });
  });

  it('parses a venue URL', () => {
    expect(parseUntappdUrl('https://untappd.com/v/some-bar/98765')).toMatchObject({ type: 'venue', id: 98765 });
  });

  it('parses a user URL', () => {
    expect(parseUntappdUrl('https://untappd.com/user/chrischall')).toEqual({
      type: 'user',
      username: 'chrischall',
      tool: 'untappd_user_info',
    });
  });

  it('parses a check-in URL', () => {
    expect(parseUntappdUrl('https://untappd.com/user/chrischall/checkin/1583983210')).toEqual({
      type: 'checkin',
      id: 1583983210,
      username: 'chrischall',
      tool: 'untappd_checkin_info',
    });
  });

  it('accepts the www host and trims whitespace', () => {
    expect(parseUntappdUrl('  https://www.untappd.com/b/x/1  ')).toMatchObject({ type: 'beer', id: 1 });
  });

  it('returns null for a non-Untappd host', () => {
    expect(parseUntappdUrl('https://example.com/b/x/1')).toBeNull();
  });

  it('returns null for an unrecognised path and for garbage', () => {
    expect(parseUntappdUrl('https://untappd.com/about')).toBeNull();
    expect(parseUntappdUrl('not a url')).toBeNull();
  });
});
