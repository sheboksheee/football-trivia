import { afterEach, describe, expect, it } from 'vitest';
import {
  FootballDataClient,
  ingestFootballData,
  ingestOpenFootball,
  crossCheckOpenFootball,
  normalizeFootballData,
  runPipeline,
  setSourceLicense,
  sourceById,
  snapshot,
  FOOTBALL_DATA_SOURCE_ID,
  OPENFOOTBALL_SOURCE_ID,
  OF_BASE_URL,
  type FetchLike,
} from '../src/index.js';
import { fakeApi, fakeClock, seasonData } from './fdFake.js';

/** OpenFootball-shaped file (fictional) re-reporting the fake football-data season. */
function ofFile(year: number, tamper?: { home: string; away: string; ft: [number, number] }) {
  const d = seasonData(year, true).matches as {
    matches: Array<{
      utcDate: string;
      homeTeam: { name: string; shortName: string };
      awayTeam: { name: string };
      score: { fullTime: { home: number; away: number } };
    }>;
  };
  return {
    name: `Fictional League ${year}/${(year + 1) % 100}`,
    matches: d.matches.map((m, i) => {
      // Spell some names differently, like real feeds do ("Alder" vs "Alder FC").
      const team1 = i % 2 ? m.homeTeam.shortName : m.homeTeam.name;
      const t = tamper && m.homeTeam.name === tamper.home && m.awayTeam.name === tamper.away;
      return {
        round: 'Matchday 1',
        date: m.utcDate.slice(0, 10),
        team1,
        team2: m.awayTeam.name,
        score: { ft: t ? tamper!.ft : [m.score.fullTime.home, m.score.fullTime.away] },
      };
    }),
  };
}
const ofSnap = (year: number, tamper?: Parameters<typeof ofFile>[1]) =>
  snapshot(
    OPENFOOTBALL_SOURCE_ID,
    'of_season',
    `FPL_${year}`,
    { competition: 'FPL', season: year, ...ofFile(year, tamper) },
    '2026-11-09T00:00:00Z',
  );

async function fdSnaps() {
  const client = new FootballDataClient({ fetch: fakeApi().f, ...fakeClock() });
  return (await ingestFootballData(client, { competitions: ['FPL'], seasons: [2024] })).snapshots;
}

afterEach(() => {
  const s = sourceById(FOOTBALL_DATA_SOURCE_ID)!;
  s.licenseStatus = 'PENDING';
  s.allowedUses = [];
  s.licenseHistory = [];
});

describe('OpenFootball cross-check', () => {
  it('fetches one CC0 file per league season from the documented path, skipping what is stored', async () => {
    const urls: string[] = [];
    const f: FetchLike = async (url) => {
      urls.push(url);
      return { status: 200, headers: { get: () => null }, json: async () => ofFile(2024) };
    };
    const r = await ingestOpenFootball({
      competitions: ['PL', 'CL', 'BL1'],
      seasons: [2024],
      have: new Set(),
      fetch: f,
    });
    expect(urls).toEqual([`${OF_BASE_URL}/2024-25/en.1.json`, `${OF_BASE_URL}/2024-25/de.1.json`]);
    expect(r.snapshots.map((s) => s.id)).toEqual([
      `snap_${OPENFOOTBALL_SOURCE_ID}_of_season_PL_2024`,
      `snap_${OPENFOOTBALL_SOURCE_ID}_of_season_BL1_2024`,
    ]);
    const again = await ingestOpenFootball({
      competitions: ['PL'],
      seasons: [2024],
      have: new Set(r.snapshots.map((s) => s.id)),
      fetch: f,
    });
    expect(again.calls).toBe(0);
  });

  it('agreeing scores corroborate; name variants still pair up', async () => {
    const kb = normalizeFootballData(await fdSnaps(), '2026-11-09');
    const r = crossCheckOpenFootball(kb, [ofSnap(2024)]);
    expect(r.compared).toBe(30);
    expect(r.agreed).toBe(30);
    expect(r.conflicts).toEqual([]);
    expect(r.unmatchedTeams).toEqual([]);
  });

  it('a disagreeing score marks the fact CONFLICTED and quarantines the questions built on it', async () => {
    const snaps = await fdSnaps();
    setSourceLicense(FOOTBALL_DATA_SOURCE_ID, {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY'],
      by: 't',
      note: 'test',
    });
    // Tamper with a match that some generated question actually uses.
    const base = runPipeline(undefined, undefined, { footballData: snaps, today: '2026-11-09' });
    const used = base.bank.all().find((q) => q.template === 'fd.mcq.match_score')!;
    const m = base.fdKb!.matches.find((x) => used.factIds.includes(x.factIds.score))!;
    const nameOf = (id: string) => base.fdKb!.entities.get(id)!.name;
    const tamper = { home: nameOf(m.home), away: nameOf(m.away), ft: [9, 9] as [number, number] };
    const res = runPipeline(undefined, undefined, {
      footballData: snaps,
      openFootball: [ofSnap(2024, tamper)],
      today: '2026-11-09',
    });
    expect(res.crossCheck!.conflicts).toHaveLength(1);
    expect(res.crossCheck!.conflicts[0]!.openFootball).toBe('9-9');
    const factId = res.crossCheck!.conflicts[0]!.factId;
    const affected = res.bank.all().filter((q) => q.factIds.includes(factId));
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.every((q) => q.status === 'QUARANTINED')).toBe(true);
    // The football-data value is kept as-is (nothing overwritten).
    expect(res.fdKb!.factIndex.get(factId)!.value).not.toBe('9-9');
    // Unrelated questions are untouched.
    const others = res.bank
      .all()
      .filter((q) => q.sourceIds.includes(FOOTBALL_DATA_SOURCE_ID) && !q.factIds.includes(factId));
    expect(others.some((q) => q.status === 'NEEDS_REVIEW')).toBe(true);
  });

  it('unknown team names are reported and skipped, never guessed', async () => {
    const kb = normalizeFootballData(await fdSnaps(), '2026-11-09');
    const s = ofSnap(2024);
    (s.payload as { matches: Array<{ team1: string }> }).matches[0]!.team1 = 'Zzyzx Wanderers';
    const r = crossCheckOpenFootball(kb, [s]);
    expect(r.unmatchedTeams).toEqual(['Zzyzx Wanderers']);
    expect(r.compared).toBe(29);
  });
});
