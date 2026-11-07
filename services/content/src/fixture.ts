/**
 * Deterministic FICTIONAL league used as the development data source. Every club, player,
 * country, stadium and match below is invented by a seeded simulator; nothing here is a real
 * football fact. Raw records are emitted as immutable snapshots with provenance hashes.
 */
import { createHash } from 'node:crypto';
import { createRng, shuffle } from '@ft/shared';
import type { RawSnapshot } from './model.js';
import { CROSSCHECK_SOURCE_ID, PENDING_SOURCE_ID, SYNTHETIC_SOURCE_ID } from './sources.js';

export const FIXTURE_SEASONS = Array.from({ length: 10 }, (_, i) => 2001 + i);
export const FIXTURE_COMPETITION = 'Synthetic Dev League';
const CUTOFF = '2010-06-30';

const TOWNS = ['Northbridge', 'Eastvale', 'Corrow', 'Hallmere', 'Westlyn', 'Brackenford', 'Sundale', 'Kestrel Bay', 'Aldermoor', 'Ravensholt'];
const SUFFIX = ['Athletic', 'Rovers', 'FC', 'Town', 'Albion', 'Wanderers', 'City', 'Harriers', 'FC', 'Rangers'];
const GROUNDS = ['Park', 'Lane', 'Meadow', 'Road', 'Arena', 'Field', 'Ground', 'Stadium', 'Common', 'Grove'];
const COUNTRIES = ['Valdoria', 'Estmark', 'Coravia', 'Norland', 'Siravel', 'Pellany'];
const FIRST = ['Aren', 'Bastio', 'Cael', 'Dorin', 'Elio', 'Fenn', 'Garo', 'Hale', 'Ivo', 'Jory', 'Kasimir', 'Lio', 'Marek', 'Nilo', 'Orin', 'Pell', 'Quin', 'Rafe', 'Soren', 'Tavi', 'Ulric', 'Vero', 'Wren', 'Yannick', 'Zev', 'Teodor', 'Matti', 'Emrys', 'Corvin', 'Silas'];
const LAST_A = ['Var', 'Hol', 'Mer', 'Dra', 'Kel', 'Sto', 'Bri', 'Lan', 'Tor', 'Fen', 'Gal', 'Ost', 'Ren', 'Wil', 'Asc', 'Pim', 'Cor', 'Del', 'Mar', 'Nov'];
const LAST_B = ['denne', 'ström', 'achi', 'ovic', 'ley', 'brand', 'mont', 'eiro', 'stad', 'quist', 'avan', 'ford', 'ini', 'berg', 'ado', 'rell', 'unza', 'holt', 'ezio', 'kaar'];
const POSITIONS = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'] as const;

export interface FxClub { id: string; name: string; shortName: string; stadium: string; founded: number }
export interface FxPlayer { id: string; first: string; last: string; position: 'GK' | 'DF' | 'MF' | 'FW'; nationality: string; shirt: number; spells: Array<{ clubId: string; from: number; to: number }> }
export interface FxMatch {
  id: string; season: number; matchday: number; date: string; homeId: string; awayId: string; homeGoals: number; awayGoals: number; venue: string;
  lineups: Record<string, Array<{ playerId: string; position: string; shirt: number }>>;
  scorers: Array<{ playerId: string; clubId: string; minute: number }>;
}
export interface FxLeague { clubs: FxClub[]; players: FxPlayer[]; matches: FxMatch[] }

export function generateLeague(seed = 20260601): FxLeague {
  const rng = createRng(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rng() * a.length)]!;
  const clubs: FxClub[] = TOWNS.map((t, i) => ({
    id: `club_${i + 1}`, name: `${t} ${SUFFIX[i]}`, shortName: t, stadium: `${t} ${GROUNDS[i]}`, founded: 1880 + Math.floor(rng() * 60),
  }));
  const usedNames = new Set<string>();
  const players: FxPlayer[] = [];
  const newPlayer = (position: FxPlayer['position']): FxPlayer => {
    let first = '', last = '';
    do { first = pick(FIRST); last = pick(LAST_A) + pick(LAST_B); } while (usedNames.has(`${first} ${last}`));
    usedNames.add(`${first} ${last}`);
    const p: FxPlayer = { id: `pl_${players.length + 1}`, first, last, position, nationality: pick(COUNTRIES), shirt: 0, spells: [] };
    players.push(p);
    return p;
  };
  // squads per club per season: 16 players (2 GK, 5 DF, 5 MF, 4 FW); ~3 changes per season
  const shape: FxPlayer['position'][] = ['GK', 'GK', 'DF', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'FW'];
  const squads: Record<string, Record<number, FxPlayer[]>> = {};
  for (const c of clubs) {
    squads[c.id] = {};
    let squad = shape.map((pos) => newPlayer(pos));
    squad.forEach((p, k) => (p.shirt = k + 1));
    for (const season of FIXTURE_SEASONS) {
      if (season > FIXTURE_SEASONS[0]!) {
        squad = [...squad];
        for (let k = 0; k < 3; k++) {
          const idx = 1 + Math.floor(rng() * (squad.length - 1));
          const out = squad[idx]!;
          // transfer: either a brand-new player or a player leaving another club
          const repl = rng() < 0.5 ? newPlayer(out.position) : newPlayer(out.position);
          repl.shirt = out.shirt;
          squad[idx] = repl;
        }
      }
      squads[c.id]![season] = squad;
      for (const p of squad) {
        const last = p.spells[p.spells.length - 1];
        if (last && last.clubId === c.id && last.to === season - 1) last.to = season;
        else p.spells.push({ clubId: c.id, from: season, to: season });
      }
    }
  }
  // inter-club transfers so some players have multiple clubs (makes Connections/alternate-link checks meaningful)
  for (let k = 0; k < 40; k++) {
    const p = pick(players);
    const lastSpell = p.spells[p.spells.length - 1];
    if (!lastSpell || lastSpell.to >= 2010) continue;
    const target = pick(clubs.filter((c) => c.id !== lastSpell.clubId));
    const from = lastSpell.to + 1;
    const to = Math.min(2010, from + 1 + Math.floor(rng() * 3));
    for (let s = from; s <= to; s++) {
      const sq = squads[target.id]![s]!;
      const idx = sq.findIndex((x, i) => i > 0 && x.position === p.position && x.spells.length === 1 && x.spells[0]!.from === s && x.spells[0]!.to === s);
      if (idx < 0) continue;
      const removed = sq[idx]!;
      removed.spells = removed.spells.filter((sp) => !(sp.clubId === target.id && sp.from === s));
      sq[idx] = p;
      const cur = p.spells[p.spells.length - 1]!;
      if (cur.clubId === target.id && cur.to === s - 1) cur.to = s;
      else p.spells.push({ clubId: target.id, from: s, to: s });
    }
  }
  const livePlayers = players.filter((p) => p.spells.length > 0);

  const matches: FxMatch[] = [];
  for (const season of FIXTURE_SEASONS) {
    // double round robin via circle method
    const ids = clubs.map((c) => c.id);
    const rounds: Array<Array<[string, string]>> = [];
    const arr = [...ids];
    for (let r = 0; r < ids.length - 1; r++) {
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < ids.length / 2; i++) pairs.push(r % 2 === 0 ? [arr[i]!, arr[arr.length - 1 - i]!] : [arr[arr.length - 1 - i]!, arr[i]!]);
      rounds.push(pairs);
      arr.splice(1, 0, arr.pop()!);
    }
    const all = [...rounds, ...rounds.map((p) => p.map(([h, a]) => [a, h] as [string, string]))];
    all.forEach((pairs, md) => {
      const d = new Date(Date.UTC(season - 1, 7, 15) + md * 7 * 86400000);
      for (const [homeId, awayId] of pairs) {
        const lineup = (clubId: string) => {
          const sq = squads[clubId]![season]!;
          const byPos = (pos: string) => shuffle(sq.filter((p) => p.position === pos), rng);
          const chosen = [...byPos('GK').slice(0, 1), ...byPos('DF').slice(0, 4), ...byPos('MF').slice(0, 4), ...byPos('FW').slice(0, 2)];
          return chosen.map((p, k) => ({ playerId: p.id, position: POSITIONS[k]!, shirt: p.shirt }));
        };
        const lineups = { [homeId]: lineup(homeId), [awayId]: lineup(awayId) };
        const goals = () => [0, 0, 1, 1, 1, 2, 2, 3, 4][Math.floor(rng() * 9)]!;
        const homeGoals = goals();
        const awayGoals = goals();
        const scorers: FxMatch['scorers'] = [];
        const addScorers = (clubId: string, n: number) => {
          const xi = lineups[clubId]!;
          for (let g = 0; g < n; g++) {
            const w: number[] = xi.map((x) => (x.position === 'FW' ? 6 : x.position === 'MF' ? 3 : x.position === 'DF' ? 1 : 0));
            let r = rng() * w.reduce((a, b) => a + b, 0);
            let idx = 0;
            while (r >= w[idx]!) { r -= w[idx]!; idx++; }
            scorers.push({ playerId: xi[idx]!.playerId, clubId, minute: 1 + Math.floor(rng() * 90) });
          }
        };
        addScorers(homeId, homeGoals);
        addScorers(awayId, awayGoals);
        scorers.sort((a, b) => a.minute - b.minute);
        matches.push({
          id: `m_${season}_${md + 1}_${homeId}_${awayId}`, season, matchday: md + 1, date: d.toISOString().slice(0, 10),
          homeId, awayId, homeGoals, awayGoals, venue: clubs.find((c) => c.id === homeId)!.stadium, lineups, scorers,
        });
      }
    });
  }
  return { clubs, players: livePlayers, matches };
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function snapshot(sourceId: string, recordType: string, externalId: string, payload: unknown, retrievedAt: string): RawSnapshot {
  const hash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return { id: `snap_${sourceId}_${recordType}_${externalId}`, sourceId, retrievedAt, recordType, externalId, payload, hash };
}

/** Converts the simulated league into provider-style raw snapshots, plus the two auxiliary feeds. */
export function fixtureSnapshots(league: FxLeague, retrievedAt = '2026-11-01T00:00:00.000Z'): RawSnapshot[] {
  const out: RawSnapshot[] = [];
  const S = SYNTHETIC_SOURCE_ID;
  out.push(snapshot(S, 'competition', 'sdl', { name: FIXTURE_COMPETITION, seasons: FIXTURE_SEASONS, cutoff: CUTOFF }, retrievedAt));
  for (const c of league.clubs) out.push(snapshot(S, 'club', c.id, c, retrievedAt));
  for (const p of league.players) out.push(snapshot(S, 'player', p.id, p, retrievedAt));
  for (const m of league.matches) out.push(snapshot(S, 'match', m.id, m, retrievedAt));
  // season stats as reported by the main feed
  const stats = seasonStats(league);
  for (const [key, v] of Object.entries(stats)) out.push(snapshot(S, 'player_season', key, v, retrievedAt));
  // cross-check feed re-reports ~80 player-seasons; 6 deliberately disagree on goals
  const rng = createRng(77);
  const keys = Object.keys(stats).filter((k) => stats[k]!.goals >= 3);
  const sample = shuffle(keys, rng).slice(0, 80);
  sample.forEach((k, i) => {
    const v = stats[k]!;
    out.push(snapshot(CROSSCHECK_SOURCE_ID, 'player_season', k, { ...v, goals: i < 6 ? v.goals + 2 : v.goals }, retrievedAt));
  });
  // pending-rights feed: stadium capacities (invented), must never be published
  for (const c of league.clubs) out.push(snapshot(PENDING_SOURCE_ID, 'stadium_capacity', c.id, { clubId: c.id, stadium: c.stadium, capacity: 12000 + Math.floor(rng() * 30000) }, retrievedAt));
  return out;
}

export function seasonStats(league: FxLeague): Record<string, { playerId: string; clubId: string; season: number; goals: number; apps: number }> {
  const out: Record<string, { playerId: string; clubId: string; season: number; goals: number; apps: number }> = {};
  for (const m of league.matches) {
    for (const [clubId, xi] of Object.entries(m.lineups)) {
      for (const s of xi) {
        const k = `${s.playerId}_${m.season}_${clubId}`;
        out[k] ??= { playerId: s.playerId, clubId, season: m.season, goals: 0, apps: 0 };
        out[k].apps++;
      }
    }
    for (const g of m.scorers) {
      const k = `${g.playerId}_${m.season}_${g.clubId}`;
      out[k]!.goals++;
    }
  }
  return out;
}
