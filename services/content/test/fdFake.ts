import type { FetchLike } from '../src/index.js';

/* Fictional teams/results shaped like the documented v4 responses. No real football data. */
export const TEAMS = [
  'Alder FC',
  'Birch United',
  'Cedar Town',
  'Dune Rovers',
  'Elm City',
  'Fir Athletic',
].map((name, i) => ({
  id: 9000 + i,
  name,
  shortName: name.split(' ')[0],
  tla: name.slice(0, 3).toUpperCase(),
  venue: `${name.split(' ')[0]} Park`,
  founded: 1900 + i,
}));
const ref = (t: (typeof TEAMS)[number]) => ({
  id: t.id,
  name: t.name,
  shortName: t.shortName,
  tla: t.tla,
  crest: null,
});

export function seasonData(year: number, finished: boolean) {
  const season = {
    id: year,
    startDate: `${year}-08-10`,
    endDate: `${year + 1}-05-20`,
    currentMatchday: 10,
    winner: null,
  };
  const matches: unknown[] = [];
  const stats = new Map(TEAMS.map((t) => [t.id, { w: 0, d: 0, l: 0, gf: 0, ga: 0, p: 0 }]));
  let id = year * 1000;
  let day = 0;
  for (const h of TEAMS)
    for (const a of TEAMS) {
      if (h === a) continue;
      const hg = (h.id + a.id + year) % 4;
      const ag = (h.id * 3 + a.id + year) % 3;
      const done = finished || day < 10;
      const date = new Date(Date.UTC(year, 7, 10) + day++ * 6 * 86400000).toISOString();
      matches.push({
        id: id++,
        utcDate: date,
        status: done ? 'FINISHED' : 'TIMED',
        matchday: Math.floor(day / 3) + 1,
        stage: 'REGULAR_SEASON',
        season,
        homeTeam: ref(h),
        awayTeam: ref(a),
        score: {
          winner: null,
          duration: 'REGULAR',
          fullTime: { home: done ? hg : null, away: done ? ag : null },
        },
      });
      if (!done) continue;
      const sh = stats.get(h.id)!;
      const sa = stats.get(a.id)!;
      sh.gf += hg;
      sh.ga += ag;
      sa.gf += ag;
      sa.ga += hg;
      if (hg > ag) {
        sh.w++;
        sh.p += 3;
        sa.l++;
      } else if (hg < ag) {
        sa.w++;
        sa.p += 3;
        sh.l++;
      } else {
        sh.d++;
        sa.d++;
        sh.p++;
        sa.p++;
      }
    }
  const table = [...TEAMS]
    .sort(
      (x, y) =>
        stats.get(y.id)!.p - stats.get(x.id)!.p ||
        stats.get(y.id)!.gf - stats.get(y.id)!.ga - (stats.get(x.id)!.gf - stats.get(x.id)!.ga) ||
        x.id - y.id,
    )
    .map((t, i) => {
      const s = stats.get(t.id)!;
      return {
        position: i + 1,
        team: ref(t),
        playedGames: s.w + s.d + s.l,
        form: null,
        won: s.w,
        draw: s.d,
        lost: s.l,
        points: s.p,
        goalsFor: s.gf,
        goalsAgainst: s.ga,
        goalDifference: s.gf - s.ga,
      };
    });
  const competition = { id: 77, name: 'Fictional Premier', code: 'FPL', type: 'LEAGUE', emblem: null };
  return {
    matches: {
      filters: { season: String(year) },
      resultSet: { count: matches.length },
      competition,
      matches,
    },
    standings: {
      filters: { season: String(year) },
      area: {},
      competition,
      season,
      standings: [{ stage: 'REGULAR_SEASON', type: 'TOTAL', group: null, table }],
    },
    teams: {
      count: TEAMS.length,
      filters: { season: String(year) },
      competition,
      season,
      teams: TEAMS.map((t) => ({ ...t, area: {}, crest: null })),
    },
  };
}

export function fakeApi(opts: { forbid?: string[]; unauthorized?: boolean; rateLimitOnce?: boolean } = {}) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let limited = false;
  const f: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers });
    const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n] ?? null },
      json: async () => body,
    });
    if (opts.unauthorized) return respond(401);
    if (opts.rateLimitOnce && !limited) {
      limited = true;
      return respond(429, {}, { 'X-RequestCounter-Reset': '7' });
    }
    const m = /competitions\/(\w+)\/(matches|standings|teams)\?season=(\d+)/.exec(url);
    if (!m) return respond(404);
    if (opts.forbid?.includes(m[1]!)) return respond(403);
    const year = Number(m[3]);
    return respond(200, seasonData(year, year < 2026)[m[2] as 'matches' | 'standings' | 'teams']);
  };
  return { f, seen };
}

export function fakeClock() {
  let t = Date.parse('2026-11-08T00:00:00Z');
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}
