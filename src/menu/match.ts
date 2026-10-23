// Menu-line normalisation and candidate scoring for untappd_menu_pick.
//
// A tap list read off a photo is noisy ("HAP & HARRY'S TENNESSEE LAGER  $6"),
// and Untappd's beer search ANDs every term — one stray word returns nothing
// (live: "i believe in nashville blonde" → 0 hits, "i believe in nashville" →
// the right beer). So a line is normalised to search-friendly tokens, searched,
// and every candidate is scored against those tokens. Pure functions only; the
// API calls live in pick.ts.

/** What kind of menu line this is. */
export type LineKind =
  /** A specific beer ("JACKALOPE FENNARIO IPA"). */
  | 'beer'
  /** "<Brewery> SEASONAL" / "<Brewery> ROTATING" — a brewery, beer unknown. */
  | 'brewery_generic'
  /** "ROTATING DRAFT BEER", "ROTATING CIDER" — nothing to look up. */
  | 'generic';

export interface NormalizedLine {
  raw: string;
  kind: LineKind;
  /** Lowercased, de-punctuated, price-free tokens. */
  tokens: string[];
  /** The brewery part of a `brewery_generic` line (e.g. "black abbey"). */
  breweryHint?: string;
}

// Words that make a line generic ("whatever's on this week").
const GENERIC_WORDS = new Set([
  'seasonal', 'seasonals', 'rotating', 'rotation', 'rotational', 'rotator', 'guest', 'featured', 'selection',
]);
// Words that carry no identity on a generic line ("ROTATING DRAFT BEER").
const GENERIC_FILLER = new Set([
  'draft', 'draught', 'beer', 'beers', 'tap', 'taps', 'handle', 'cider', 'ciders', 'seltzer', 'seltzers',
  'select', 'of', 'the', 'our', 'current', 'ask', 'your', 'server', 'bartender', 'on', 'brew', 'brews', 'release',
]);
// Serving words a menu adds that are never part of a beer's name.
const SERVING_WORDS = new Set(['draft', 'draught', 'pint', 'pints', 'pour', 'can', 'cans', 'bottle', 'bottles', 'glass']);

/**
 * Bare style words. Untappd keeps the style out of most beer NAMES ("Fennario",
 * style "IPA - American"), so a line's style word is dropped from the fallback
 * search query and, when scoring, is explained by the candidate's style.
 * Deliberately excludes differentiators like "double"/"imperial" — "Double
 * Homestyle" is a different beer from "Homestyle".
 */
const STYLE_WORDS = new Set([
  'ipa', 'ipas', 'lager', 'pilsner', 'pils', 'blonde', 'blond', 'ale', 'stout', 'porter', 'sour', 'saison', 'gose',
  'hefeweizen', 'kolsch', 'cider', 'seltzer', 'pale', 'amber', 'wheat', 'witbier', 'helles', 'marzen', 'dunkel',
]);

// Brewery-name words that don't identify the brewery ("Brewing Company").
const BREWERY_NOISE = new Set([
  'brewing', 'brewery', 'breweries', 'brewers', 'brewhouse', 'brew', 'company', 'co', 'beer', 'beers', 'ales',
  'the', 'and', 'works', 'project', 'craft', 'inc', 'llc',
]);

/** Lowercase, strip accents/apostrophes, turn every other non-alphanumeric into a space. */
export function tokenize(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '') // harry's / harry’s → harrys, so either spelling matches
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

// Prices, pour sizes and ABV a menu prints next to the name.
const NOISE_PATTERNS = [
  /\$\s*\d+(?:[.,]\d{1,2})?/g, // $6, $ 7.50
  /\b\d+(?:[.,]\d+)?\s*%(?:\s*abv)?/gi, // 6.5%, 7% ABV
  /\babv\b\s*\d+(?:[.,]\d+)?/gi, // ABV 6.5
  /\b\d+(?:[.,]\d+)?\s*(?:oz|ml|cl|l)\b/gi, // 16oz, 12 oz, 330ml
  /\b\d+[.,]\d{2}\b/g, // 7.00
  /\b\d{1,2}\s*\/\s*\d{1,2}\s*$/g, // trailing "6/9" price columns (a bare trailing number may be part of a name)
];

/** Normalise one raw menu line and classify it. */
export function normalizeLine(raw: string): NormalizedLine {
  let s = raw;
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  const tokens: string[] = [];
  for (const t of tokenize(s)) {
    // Collapse a duplicated word ("IPA IPA", "Lager Lager") from OCR or a
    // style column printed after a name that already ends in the style.
    if (tokens[tokens.length - 1] === t) continue;
    tokens.push(t);
  }
  // Generic only when nothing but filler follows the last generic word:
  // "BLACK ABBEY SEASONAL" and "ROTATING DRAFT BEER" are, but "Widmer Rotator
  // IPA" is a real beer whose name happens to contain one.
  let lastGeneric = -1;
  tokens.forEach((t, i) => {
    if (GENERIC_WORDS.has(t)) lastGeneric = i;
  });
  if (lastGeneric !== -1 && tokens.slice(lastGeneric + 1).every((t) => GENERIC_FILLER.has(t))) {
    const rest = tokens.filter((t) => !GENERIC_WORDS.has(t) && !GENERIC_FILLER.has(t));
    return rest.length === 0
      ? { raw, kind: 'generic', tokens }
      : { raw, kind: 'brewery_generic', tokens, breweryHint: rest.join(' ') };
  }
  const named = tokens.filter((t) => !SERVING_WORDS.has(t));
  return { raw, kind: named.length ? 'beer' : 'generic', tokens: named };
}

/** Search queries to try for a line, most specific first (deduped). */
export function searchQueries(line: NormalizedLine): string[] {
  const full = line.tokens.join(' ');
  const noStyle = line.tokens.filter((t) => !STYLE_WORDS.has(t)).join(' ');
  return [...new Set([full, noStyle].filter(Boolean))];
}

/** One beer candidate, from a search result or a brewery beer list. */
export interface Candidate {
  bid: number;
  name: string;
  brewery: string;
  brewery_id: number | null;
  brewery_city: string | null;
  style: string | null;
  abv: number | null;
  checkin_count: number;
  /** Global rating when the source carried one (brewery lists do; search doesn't). */
  rating: number | null;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  /** Fraction of the beer-name tokens found in the line. */
  name_match: number;
  /** Fraction of the identifying brewery-name tokens found in the line. */
  brewery_match: number;
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});
const numOr = (v: unknown, d: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strOr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Map a raw `/search/beer` item (`{checkin_count, beer, brewery}`) to a {@link Candidate}. */
export function candidateFromSearch(item: unknown): Candidate | null {
  const i = dict(item);
  const beer = dict(i.beer);
  const brewery = dict(i.brewery);
  const bid = numOr(beer.bid, null);
  if (bid === null) return null;
  return {
    bid,
    name: strOr(beer.beer_name) ?? '',
    brewery: strOr(brewery.brewery_name) ?? '',
    brewery_id: numOr(brewery.brewery_id, null),
    brewery_city: strOr(dict(brewery.location).brewery_city),
    style: strOr(beer.beer_style),
    abv: numOr(beer.beer_abv, null),
    checkin_count: numOr(i.checkin_count, 0) ?? 0,
    rating: numOr(beer.rating_score, null) || null,
  };
}

/**
 * Score a candidate against a line's tokens. Higher is better. The terms:
 *  - beer-name tokens found in the line (×4) and brewery tokens found (×3);
 *  - each beer-name token NOT in the line costs 1.5 — the "Double Homestyle"
 *    / "Triple Homestyle" guard when the menu said "Homestyle";
 *  - each line token the candidate can't explain (by brewery, name or style)
 *    costs 1;
 *  - popularity, log10(check-ins) × 0.5 — the canonical 35k-check-in entry
 *    beats a 3-check-in duplicate with the same name;
 *  - +1 when the brewery's city is the venue's city (the tie-breaker).
 */
export function scoreCandidate(lineTokens: string[], c: Candidate, venueCity?: string): ScoredCandidate {
  const line = new Set(lineTokens);
  const breweryAll = tokenize(c.brewery);
  const breweryId = breweryAll.filter((t) => !BREWERY_NOISE.has(t));
  const brewery = breweryId.length ? breweryId : breweryAll;
  const name = tokenize(c.name);
  const style = tokenize(c.style ?? '');
  const frac = (ts: string[]) => (ts.length ? ts.filter((t) => line.has(t)).length / ts.length : 0);
  const brewery_match = frac(brewery);
  const name_match = frac(name);
  const extraName = name.filter((t) => !line.has(t)).length;
  const explained = new Set([...breweryAll, ...name, ...style, ...BREWERY_NOISE]);
  const unexplained = lineTokens.filter((t) => !explained.has(t)).length;
  const sameCity =
    venueCity && c.brewery_city && tokenize(venueCity).join(' ') === tokenize(c.brewery_city).join(' ') ? 1 : 0;
  const score =
    4 * name_match +
    3 * brewery_match -
    1.5 * extraName -
    unexplained +
    0.5 * Math.log10(c.checkin_count + 1) +
    sameCity;
  return { ...c, score: Math.round(score * 1000) / 1000, name_match, brewery_match };
}

/** Rank candidates for a line, best first. Duplicate bids keep their best score. */
export function rankCandidates(lineTokens: string[], cands: Candidate[], venueCity?: string): ScoredCandidate[] {
  const best = new Map<number, ScoredCandidate>();
  for (const c of cands) {
    const s = scoreCandidate(lineTokens, c, venueCity);
    const prev = best.get(c.bid);
    if (!prev || s.score > prev.score) best.set(c.bid, s);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.checkin_count - a.checkin_count);
}

/**
 * Is the top candidate a confident match? Most of the beer's name must be on
 * the line, and the total must clear a floor that a name-only hit from an
 * unrelated brewery doesn't reach.
 */
export function isConfident(top: ScoredCandidate | undefined): boolean {
  return !!top && top.name_match >= 0.5 && top.score >= 4.5;
}

// Name/style hints that a brewery's beer is a seasonal or limited release.
const SEASONAL_RE =
  /season|oktoberfest|okto|marzen|festbier|\bfest\b|pumpkin|winter|summer|spring|autumn|\bfall\b|harvest|holiday|christmas|xmas|noel|snow|maibock|wet hop|fresh hop|shandy|radler|limited|rotat|anniversary/i;

/** Does this beer look like a seasonal / limited release? */
export function looksSeasonal(name: string, style: string | null): boolean {
  return SEASONAL_RE.test(tokenize(name).join(' ')) || SEASONAL_RE.test(tokenize(style ?? '').join(' '));
}

/** Score a `/search/brewery` result's name against a brewery hint (fraction of hint tokens matched). */
export function breweryNameMatch(hint: string, breweryName: string): number {
  const hintTokens = tokenize(hint).filter((t) => !BREWERY_NOISE.has(t));
  const name = new Set(tokenize(breweryName));
  return hintTokens.length ? hintTokens.filter((t) => name.has(t)).length / hintTokens.length : 0;
}
