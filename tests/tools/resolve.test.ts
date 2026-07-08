import { describe, it, expect, vi, afterAll } from 'vitest';
import { client } from '../../src/client.js';
import { parseUntappdUrl, registerResolveTools } from '../../src/tools/resolve.js';
import { createTestHarness } from '../helpers.js';

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

describe('untappd_open_url (resolve + fetch)', () => {
  const get = vi.spyOn(client, 'get').mockResolvedValue(undefined as never);
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  afterAll(async () => {
    if (harness) await harness.close();
  });

  function parse(result: { content: { text: string }[] }): Record<string, unknown> {
    return JSON.parse(result.content[0].text);
  }

  const ROUTES: [string, string][] = [
    ['https://untappd.com/b/x/4499', '/beer/info/4499'],
    ['https://untappd.com/w/x/5143', '/brewery/info/5143'],
    ['https://untappd.com/v/x/98765', '/venue/info/98765'],
    ['https://untappd.com/user/chrischall', '/user/info/chrischall'],
    ['https://untappd.com/user/chrischall/checkin/1583983210', '/checkin/view/1583983210'],
  ];

  it('setup', async () => {
    harness = await createTestHarness((server) => registerResolveTools(server));
  });

  for (const [url, path] of ROUTES) {
    it(`routes ${url} to ${path}`, async () => {
      get.mockClear();
      get.mockResolvedValueOnce({ ok: true });
      const r = await harness.callTool('untappd_open_url', { url });
      expect(get).toHaveBeenCalledWith(path);
      const out = parse(r as never);
      expect(out.resolved).toBeDefined();
      expect(out.detail).toEqual({ ok: true });
    });
  }

  it('errors (no fetch) on an unrecognised URL', async () => {
    get.mockClear();
    const r = await harness.callTool('untappd_open_url', { url: 'https://example.com/x' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
