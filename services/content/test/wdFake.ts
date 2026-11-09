import type { FetchLike } from '../src/index.js';

/*
 * Fictional Wikidata-shaped responses (search API + SPARQL JSON). Ids, clubs and players are made
 * up (Q9xxxxx range) — no real football facts.
 */
export const WD_TEAMS = [
  { fdId: 9000, name: 'Alder FC', shortName: 'Alder', competitionCode: 'FPL' },
  { fdId: 9001, name: 'Birch United', shortName: 'Birch', competitionCode: 'FPL' },
  { fdId: 9002, name: 'Cedar Town', shortName: 'Cedar', competitionCode: 'FPL' },
  { fdId: 9003, name: 'Dune Rovers', shortName: 'Dune', competitionCode: 'FPL' },
  { fdId: 9004, name: 'Elm City', shortName: 'Elm', competitionCode: 'FPL' },
];
export const CLUB_QID: Record<string, string> = {
  'Alder FC': 'Q9100000',
  'Birch United': 'Q9100001',
  'Cedar Town': 'Q9100002',
  'Dune Rovers': 'Q9100003',
  'Elm City': 'Q9100004',
};

/** 10 fictional players; each row = one membership statement. */
const P = (n: number, en: string, ar: string, sl: number, nat: string) => ({
  q: `Q92000${n}`,
  en,
  ar,
  sl,
  nat,
});
export const PLAYERS = [
  P(0, 'Aron Vale', 'آرون فيل', 95, 'Norland'),
  P(1, 'Bruno Kest', 'برونو كيست', 88, 'Sudmark'),
  P(2, 'Carlo Ruin', 'كارلو روين', 80, 'Norland'),
  P(3, 'Dario Moss', 'داريو موس', 72, 'Eastvale'),
  P(4, 'Emil Thorne', 'إميل ثورن', 66, 'Westria'),
  P(5, 'Felix Arno', 'فيليكس آرنو', 58, 'Sudmark'),
  P(6, 'Gino Pratt', 'جينو برات', 52, 'Eastvale'),
  P(7, 'Hugo Lind', 'هوجو ليند', 49, 'Westria'),
  P(8, 'Ivo Brandt', 'إيفو برانت', 47, 'Norland'),
  P(9, 'Jonas Velt', 'يوناس فلت', 46, 'Sudmark'),
];
/** player index -> clubs (by name) with start year */
const CAREERS: Record<number, Array<[string, number, number | null]>> = {
  0: [
    ['Alder FC', 2010, 2015],
    ['Birch United', 2015, null],
  ],
  1: [
    ['Alder FC', 2011, 2014],
    ['Cedar Town', 2014, 2020],
  ],
  2: [
    ['Alder FC', 2012, 2016],
    ['Dune Rovers', 2016, 2019],
  ],
  3: [['Alder FC', 2013, 2018]],
  4: [
    ['Alder FC', 2014, 2019],
    ['Birch United', 2019, 2022],
  ],
  5: [
    ['Birch United', 2010, 2013],
    ['Elm City', 2013, null],
  ],
  6: [
    ['Birch United', 2012, 2014],
    ['Elm City', 2014, 2016],
  ],
  7: [
    ['Birch United', 2014, 2017],
    ['Elm City', 2017, 2020],
  ],
  8: [
    ['Birch United', 2016, 2018],
    ['Elm City', 2018, 2021],
  ],
  9: [['Cedar Town', 2015, 2018]],
};

export function fakeWikidata(
  opts: { down?: boolean; womenFirst?: string[]; stubFirst?: string[]; failPlayersFor?: string } = {},
) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const respond = (status: number, body: unknown = {}) => ({
    status,
    headers: { get: () => null },
    json: async () => body,
  });
  const f: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (opts.down) throw new Error('getaddrinfo ENOTFOUND');
    const u = new URL(url);
    if (u.pathname === '/w/api.php') {
      const name = u.searchParams.get('search') ?? '';
      const qid = CLUB_QID[name];
      const results = [
        ...(opts.stubFirst?.includes(name)
          ? [{ id: 'Q9177777', label: name, description: 'association football club' }]
          : []),
        ...(opts.womenFirst?.includes(name)
          ? [{ id: 'Q9199999', label: `${name} Women`, description: "women's association football club" }]
          : []),
        ...(qid ? [{ id: qid, label: name, description: 'association football club (fictional)' }] : []),
        { id: 'Q9188888', label: `${name} (song)`, description: 'song' },
      ];
      return respond(200, { searchinfo: { search: name }, search: results });
    }
    const q = u.searchParams.get('query') ?? '';
    const b = (o: Record<string, string>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: 'literal', value: v }]));
    const ent = (id: string) => `http://www.wikidata.org/entity/${id}`;
    if (q.includes('VALUES ?c')) {
      const ids = [...q.matchAll(/wd:(Q\d+)/g)].map((m) => m[1]!).filter((x) => x !== 'Q476028');
      const clubs = Object.entries(CLUB_QID).filter(([, id]) => ids.includes(id));
      const rows = [
        ...clubs.map(([name, id]) => b({ c: ent(id), en: name, ar: `نادي ${name}`, sl: '120' })),
        ...(ids.includes('Q9177777') ? [b({ c: ent('Q9177777'), en: 'Stub', sl: '2' })] : []),
        ...(ids.includes('Q9199999') ? [b({ c: ent('Q9199999'), en: 'Women side', sl: '300' })] : []),
      ];
      return respond(200, { head: { vars: ['c', 'en', 'ar'] }, results: { bindings: rows } });
    }
    const club = /ps:P54 wd:(Q\d+)/.exec(q)?.[1];
    if (club) {
      if (club === opts.failPlayersFor) return respond(500);
      const name = Object.entries(CLUB_QID).find(([, id]) => id === club)?.[0];
      const rows = PLAYERS.flatMap((p, i) =>
        (CAREERS[i] ?? [])
          .filter(([c]) => c === name)
          .map(([, from, to]) =>
            b({
              p: ent(p.q),
              sl: String(p.sl),
              en: p.en,
              ar: p.ar,
              nat: p.nat,
              from: `${from}-07-01T00:00:00Z`,
              ...(to ? { to: `${to}-06-30T00:00:00Z` } : {}),
            }),
          ),
      );
      return respond(200, { head: { vars: [] }, results: { bindings: rows } });
    }
    return respond(400);
  };
  return { f, seen };
}
