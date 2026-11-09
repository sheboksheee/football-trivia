/**
 * OpenFootball football.json (CC0 1.0, github.com/openfootball/football.json, LICENSE.md verified
 * 2026-11-09) used as an independent cross-check of football-data.org league results.
 *
 * File layout (verified): https://raw.githubusercontent.com/openfootball/football.json/master/<YYYY-YY>/<code>.json
 * with `{ name, matches: [{ round, date, team1, team2, score: { ht, ft } }] }`.
 *
 * In a league season each home/away pairing happens exactly once, so matches are paired by
 * (competition, season, home club, away club). Disagreeing full-time scores mark the football-data
 * fact CONFLICTED, which quarantines every question built on it (TRUTH gate). Nothing is overwritten.
 */
import { z } from 'zod';
import { bestMatch } from '@ft/shared';
import { snapshot } from '../fixture.js';
import type { RawSnapshot } from '../model.js';
import { OPENFOOTBALL_SOURCE_ID } from '../sources.js';
import type { FetchLike } from './footballData.js';
import type { FdKB } from './footballDataContent.js';

export const OF_BASE_URL = 'https://raw.githubusercontent.com/openfootball/football.json/master';
/** football-data.org competition code -> OpenFootball file code. */
export const OF_CODES: Record<string, string> = {
  PL: 'en.1',
  PD: 'es.1',
  SA: 'it.1',
  BL1: 'de.1',
  FL1: 'fr.1',
};

const OfFile = z.object({
  name: z.string().optional(),
  matches: z.array(
    z
      .object({
        date: z.string().optional(),
        team1: z.string(),
        team2: z.string(),
        score: z
          .object({ ft: z.tuple([z.number(), z.number()]).optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  ),
});

/** "2023/24" -> "2023-24" */
export const ofSeasonFolder = (startYear: number) =>
  `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

export async function ingestOpenFootball(o: {
  competitions: string[];
  seasons: number[];
  have: Set<string>;
  fetch?: FetchLike;
  refresh?: boolean;
  now?: () => string;
  onSnapshot?: (s: RawSnapshot) => Promise<void> | void;
}): Promise<{ snapshots: RawSnapshot[]; calls: number; skipped: Array<{ what: string; reason: string }> }> {
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init) as never);
  const out = {
    snapshots: [] as RawSnapshot[],
    calls: 0,
    skipped: [] as Array<{ what: string; reason: string }>,
  };
  for (const comp of o.competitions) {
    const code = OF_CODES[comp];
    if (!code) continue;
    for (const season of o.seasons) {
      const ext = `${comp}_${season}`;
      if (o.have.has(`snap_${OPENFOOTBALL_SOURCE_ID}_of_season_${ext}`) && !o.refresh) continue;
      const url = `${OF_BASE_URL}/${ofSeasonFolder(season)}/${code}.json`;
      out.calls++;
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await f(url, { headers: { accept: 'application/json' } });
      } catch {
        out.skipped.push({ what: ext, reason: 'NETWORK' });
        return out;
      }
      if (res.status !== 200) {
        out.skipped.push({ what: ext, reason: res.status === 404 ? 'NOT_FOUND' : `HTTP ${res.status}` });
        continue;
      }
      const body = OfFile.safeParse(await res.json().catch(() => null));
      if (!body.success) {
        out.skipped.push({ what: ext, reason: 'INVALID' });
        continue;
      }
      const s = snapshot(
        OPENFOOTBALL_SOURCE_ID,
        'of_season',
        ext,
        { competition: comp, season, ...body.data },
        (o.now ?? (() => new Date().toISOString()))(),
      );
      out.snapshots.push(s);
      await o.onSnapshot?.(s);
    }
  }
  return out;
}

export interface CrossCheckReport {
  compared: number;
  agreed: number;
  unmatchedTeams: string[];
  conflicts: Array<{ match: string; footballData: string; openFootball: string; factId: string }>;
}

/**
 * Compares full-time scores. Agreement = corroboration; disagreement = CONFLICTED (quarantine).
 * Team names are paired per season with the typo-tolerant matcher; a name that does not resolve to
 * exactly one club is skipped (reported), never guessed.
 */
export function crossCheckOpenFootball(kb: FdKB, snaps: RawSnapshot[]): CrossCheckReport {
  const report: CrossCheckReport = { compared: 0, agreed: 0, unmatchedTeams: [], conflicts: [] };
  const unmatched = new Set<string>();
  for (const s of snaps.filter(
    (x) => x.sourceId === OPENFOOTBALL_SOURCE_ID && x.recordType === 'of_season',
  )) {
    const p = OfFile.extend({ competition: z.string(), season: z.number() }).safeParse(s.payload);
    if (!p.success) continue;
    const label = `${p.data.season}/${String((p.data.season + 1) % 100).padStart(2, '0')}`;
    const fdMatches = kb.matches.filter(
      (m) => m.competitionCode === p.data.competition && m.season === label && m.regular,
    );
    if (!fdMatches.length) continue;
    const clubIds = [...new Set(fdMatches.flatMap((m) => [m.home, m.away]))];
    const aliasesOf = (id: string) => {
      const e = kb.entities.get(id);
      return e ? [e.name, ...e.aliases] : [id];
    };
    const resolve = new Map<string, string | null>();
    const club = (name: string) => {
      if (!resolve.has(name)) resolve.set(name, bestMatch(name, clubIds, aliasesOf));
      const r = resolve.get(name)!;
      if (!r) unmatched.add(name);
      return r;
    };
    const byPair = new Map(fdMatches.map((m) => [`${m.home}|${m.away}`, m]));
    for (const m of p.data.matches) {
      const ft = m.score?.ft;
      if (!ft) continue;
      const h = club(m.team1);
      const a = club(m.team2);
      if (!h || !a || h === a) continue;
      const fd = byPair.get(`${h}|${a}`);
      if (!fd) continue;
      report.compared++;
      const fact = kb.factIndex.get(fd.factIds.score);
      if (!fact) continue;
      if (fd.homeGoals === ft[0] && fd.awayGoals === ft[1]) report.agreed++;
      else {
        fact.status = 'CONFLICTED';
        report.conflicts.push({
          match: `${m.team1} v ${m.team2} (${label})`,
          footballData: `${fd.homeGoals}-${fd.awayGoals}`,
          openFootball: `${ft[0]}-${ft[1]}`,
          factId: fact.id,
        });
      }
    }
  }
  report.unmatchedTeams = [...unmatched].sort();
  return report;
}
