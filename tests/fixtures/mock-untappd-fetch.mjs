// Preloaded (`node --import`) into a REAL server process by the persistence
// tests: replaces global fetch with a fake Untappd v4 API so the spawned
// server can sync without the network. Every request URL is appended to
// $MOCK_LOG (one per line) so the test can count API calls per process.
//
//   MOCK_USERS        JSON {"<username>": <distinct beer count>}
//   MOCK_FAIL_AFTER   optional: answer 429 once this many requests were served
import { appendFileSync } from 'node:fs';

const users = JSON.parse(process.env.MOCK_USERS ?? '{}');
const failAfter = process.env.MOCK_FAIL_AFTER ? Number(process.env.MOCK_FAIL_AFTER) : Infinity;
let served = 0;

function beer(user, i) {
  // Distinct bid ranges per user; newest (highest i) first in sort=date order.
  const base = Object.keys(users).indexOf(user) * 1_000_000 + 1000;
  return {
    count: 1,
    user_rating_score: 4,
    first_created_at: 'Wed, 10 Feb 2016 12:00:00 +0000',
    recent_created_at: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toUTCString(),
    beer: { bid: base + i, beer_name: `Beer ${base + i}`, beer_style: 'IPA - American', beer_abv: 6.5 },
    brewery: { brewery_id: 7, brewery_name: 'Brew Co' },
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `${url.pathname}${url.search}\n`);
  if (served >= failAfter) return json(429, { meta: { code: 429, error_detail: 'rate limited' } });
  served++;
  const m = url.pathname.match(/^\/v4\/user\/beers\/([^/]+)$/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    const total = users[user] ?? 0;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const items = [];
    for (let k = offset; k < Math.min(total, offset + limit); k++) items.push(beer(user, total - 1 - k));
    return json(200, { meta: { code: 200 }, response: { total_count: total, beers: { count: items.length, items } } });
  }
  return json(404, { meta: { code: 404, error_detail: `mock: no route for ${url.pathname}` } });
};
