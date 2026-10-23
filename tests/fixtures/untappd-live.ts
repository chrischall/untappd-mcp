// Untappd v4 payloads captured live on 2026-10-23 for the menu-pick tests,
// trimmed to the fields the pipeline reads (search items keep their raw
// {checkin_count, beer, brewery} shape). Queries Untappd answered with ZERO
// hits are recorded as [] — that behaviour (search ANDs every term) is what
// the fallback query exists for.

type Item = Record<string, unknown>;

const brewery = (brewery_id: number, brewery_name: string, brewery_city = 'Nashville') => ({
  brewery_id,
  brewery_name,
  location: { brewery_city, brewery_state: 'TN' },
});
const HAP = brewery(53519, 'Hap & Harry’s ');
const I_BELIEVE = brewery(464666, 'I Believe Brewing Company');
const JACKALOPE = brewery(12023, 'Jackalope Brewing Company');
const BEARDED_IRIS = brewery(194785, 'Bearded Iris Brewing');
const BLACK_ABBEY = brewery(20035, 'The Black Abbey Brewing Company');

const hit = (checkin_count: number, bid: number, beer_name: string, beer_style: string, beer_abv: number, b: Item): Item => ({
  checkin_count,
  beer: { bid, beer_name, beer_style, beer_abv },
  brewery: b,
});

/** `/search/beer?q=` → beers.items, keyed by the exact query string sent. */
export const SEARCH_BEER: Record<string, Item[]> = {
  'hap and harrys tennessee lager': [],
  'hap harrys tennessee lager': [
    hit(35688, 304831, 'Tennessee Lager', 'Lager - Pale', 4.9, HAP),
    // The 3-check-in duplicate entry for the same beer.
    hit(3, 6894790, 'Tennessee Lager', 'Lager - American', 4.9, HAP),
  ],
  'i believe in nashville blonde': [],
  'i believe in nashville': [
    hit(5244, 3780741, 'I Believe In Nashville', 'Blonde / Golden Ale - American', 4.5, I_BELIEVE),
    hit(223, 3820931, 'I Believe in Nashville', 'Blonde / Golden Ale - Other', 4.5, HAP),
    hit(60, 4759334, 'I Believe In Nashville Cherry Limeade', 'Hard Seltzer', 4.5, I_BELIEVE),
    hit(36, 5282658, 'I Believe In Nashville Peach', 'Blonde / Golden Ale - Other', 4.5, I_BELIEVE),
    hit(12, 5423261, 'I Believe In Nashville Dreamsicle Hard Seltzer', 'Hard Seltzer', 4.5, I_BELIEVE),
  ],
  'jackalope fennario ipa': [hit(15971, 1893601, 'Fennario   ', 'IPA - American', 7.2, JACKALOPE)],
  'bearded iris homestyle': [
    hit(156626, 1502190, 'Homestyle', 'IPA - New England / Hazy', 6, BEARDED_IRIS),
    hit(32722, 1942304, 'Double Homestyle', 'IPA - Imperial / Double New England / Hazy', 8.2, BEARDED_IRIS),
    hit(6121, 3073599, 'Triple Homestyle', 'IPA - Triple', 10, BEARDED_IRIS),
    hit(1213, 2269232, 'Double Homestyle DDH W/ Galaxy', 'IPA - Imperial / Double New England / Hazy', 8.2, BEARDED_IRIS),
    hit(921, 2380552, 'Double Homestyle DDH W/ Citra', 'IPA - Imperial / Double New England / Hazy', 8.2, BEARDED_IRIS),
    hit(432, 4195961, 'Triple Homestyle (Wet Hopped W/ Citra)', 'IPA - Triple', 10, BEARDED_IRIS),
    hit(343, 1816572, 'Homestyle W/ Blueberry And Honey', 'IPA - New England / Hazy', 6, BEARDED_IRIS),
  ],
};

/** `/search/brewery?q=` → brewery.items. */
export const SEARCH_BREWERY: Record<string, Item[]> = {
  'black abbey': [{ brewery: { ...BLACK_ABBEY, beer_count: 100 } }],
};

const listed = (total_count: number, bid: number, beer_name: string, beer_style: string, beer_abv: number, rating_score: number): Item => ({
  total_count,
  beer: { bid, beer_name, beer_style, beer_abv, rating_score, is_in_production: 1 },
  brewery: BLACK_ABBEY,
});

/** `/brewery/beer_list/20035` (default "Most Popular" order), first 20 of 50. */
export const BLACK_ABBEY_BEERS: Item[] = [
  listed(30763, 349665, 'The Rose', 'Belgian Blonde', 5.4, 3.616),
  listed(16850, 827528, 'Five Points IPA', 'IPA - American', 7, 3.652),
  listed(10008, 456203, 'The Special', 'Belgian Dubbel', 7.4, 3.703),
  listed(9508, 3117832, 'Tennessee IPA', 'IPA - New England / Hazy', 6, 3.642),
  listed(5012, 1223176, 'Chronicles Festbier', 'Festbier', 4.9, 3.672),
  listed(4495, 1336080, 'Krampus Nacht', 'Bock - Single / Traditional', 7, 3.812),
  listed(4325, 434063, 'Guy Fawkes', 'Brown Ale - English', 5, 3.721),
  listed(2232, 5323653, 'Pub Ale', 'Bitter - Extra Special / Strong (ESB)', 4.8, 3.662),
  listed(1473, 2040420, 'Grand Design', 'Belgian Tripel', 8.5, 3.845),
  listed(1173, 3646188, 'Czech Condition', 'Pilsner - Czech / Bohemian', 4.9, 3.745),
  listed(1128, 2561807, "Edley's Best", 'Blonde / Golden Ale - Other', 5.4, 3.597),
  listed(617, 5248332, 'Irish Red Ale', 'Red Ale - Irish', 5.8, 3.82),
  listed(596, 4056682, 'Ancient Ways Quad', 'Belgian Quadrupel', 9, 3.966),
  listed(448, 1200066, 'Leo X Anniversary Ale', 'IPA - Other', 7.4, 3.804),
  listed(184, 6189412, 'Maibock / Helles Bock Lager', 'Bock - Hell / Maibock / Lentebock', 7.3, 3.838),
  listed(117, 6701168, 'Barrel-aged Maibock', 'Bock - Hell / Maibock / Lentebock', 9.7, 4.058),
  listed(77, 1259218, 'Chronicles (Cask Conditioned)', 'Festbier', 4.9, 3.77),
  listed(54, 3190952, 'Noelle', 'Belgian Strong Golden Ale', 7.8, 3.988),
  listed(53, 1681306, 'Savannah Saison', 'Farmhouse Ale - Saison', 6, 3.892),
  listed(28, 3636953, 'Zwickel Zwackel', 'Kellerbier / Zwickelbier', 4, 3.666),
];

/** `/beer/info/<bid>` (compact): the fields beerMetaFrom reads. */
export const BEER_INFO: Record<number, Item> = {
  304831: { bid: 304831, beer_name: 'Tennessee Lager', beer_style: 'Lager - Pale', parent_style_name: 'Pale Lager / Pilsner', beer_abv: 4.9, rating_score: 3.32364, weighted_rating_score: 3.32671, rating_count: 27784, brewery: HAP },
  3780741: { bid: 3780741, beer_name: 'I Believe In Nashville', beer_style: 'Blonde / Golden Ale - American', parent_style_name: 'Blonde / Golden Ale', beer_abv: 4.5, rating_score: 3.52762, weighted_rating_score: 3.53623, rating_count: 4487, brewery: I_BELIEVE },
  1893601: { bid: 1893601, beer_name: 'Fennario   ', beer_style: 'IPA - American', parent_style_name: 'India Pale Ale (IPA)', beer_abv: 7.2, rating_score: 3.67627, weighted_rating_score: 3.67684, rating_count: 12836, brewery: JACKALOPE },
  1502190: { bid: 1502190, beer_name: 'Homestyle', beer_style: 'IPA - New England / Hazy', parent_style_name: 'India Pale Ale (IPA)', beer_abv: 6, rating_score: 3.98554, weighted_rating_score: 3.98492, rating_count: 99111, brewery: BEARDED_IRIS },
};
