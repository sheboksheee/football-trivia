import { describe, expect, it } from 'vitest';
import type { AuctionItem, Top25Item } from '@ft/shared';
import {
  FootballDataClient,
  ingestFootballData,
  normalizeFootballData,
  generateFootballDataCandidates,
  type FdKB,
  type FdTable,
} from '../src/index.js';
import { fakeApi, fakeClock } from './fdFake.js';

async function kb(): Promise<FdKB> {
  const client = new FootballDataClient({ fetch: fakeApi().f, ...fakeClock() });
  const r = await ingestFootballData(client, { competitions: ['FPL'], seasons: [2024] });
  return normalizeFootballData(r.snapshots, '2026-11-09');
}

/** Five fictional "big five" tables built from the fake one (team ids made unique per league). */
function big5(k: FdKB, tweak?: (code: string, rows: FdTable['rows']) => void): FdKB {
  const base = k.tables.find((t) => t.complete)!;
  const tables = ['PL', 'PD', 'SA', 'BL1', 'FL1'].map((code, li) => {
    const rows = base.rows.map((r, i) => ({
      ...r,
      team: `${r.team}_${code}`,
      points: r.points + li * 7 + i, // distinct values
      goalsFor: r.goalsFor + li * 5 + i * 2,
    }));
    tweak?.(code, rows);
    return { ...base, competitionCode: code, rows };
  });
  return { ...k, tables };
}

const gen = (k: FdKB) => generateFootballDataCandidates(k, { today: '2026-11-09' });

describe('football-data Auction and TOP 25', () => {
  it('Auction: the complete final table is the answer universe (every club, once)', async () => {
    const k = await kb();
    const a = gen(k).filter((c) => c.template === 'fd.auction.league_clubs');
    expect(a).toHaveLength(1);
    const item = a[0]!.item as AuctionItem;
    expect(item.universe).toHaveLength(6);
    expect(new Set(item.universe.map((u) => u.label)).size).toBe(6);
    expect(a[0]!.validators.every((v) => v.passed)).toBe(true);
  });

  it('TOP 25: needs all five complete tables; strictly ordered, 25 unique clubs', async () => {
    const k = await kb();
    expect(gen(k).filter((c) => c.kind === 'top25')).toHaveLength(0); // only one league
    const t = gen(big5(k)).filter((c) => c.kind === 'top25');
    expect(t.map((c) => c.template).sort()).toEqual(['fd.top25.big5_goalsFor', 'fd.top25.big5_points']);
    for (const c of t) {
      const item = c.item as Top25Item;
      expect(item.entries).toHaveLength(25);
      expect(item.entries.map((e) => e.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(c.validators.every((v) => v.passed)).toBe(true);
    }
  });

  it('TOP 25: a tie that survives the tie-break at the 25/26 boundary rejects the list', async () => {
    const k = big5(await kb());
    const all = k.tables
      .flatMap((t) => t.rows)
      .sort((a, b) => b.points - a.points || b.goalsFor - a.goalsFor);
    const [p25, p26] = [all[24]!, all[25]!];
    p26.points = p25.points;
    p26.goalsFor = p25.goalsFor;
    const pts = gen(k).find((c) => c.template === 'fd.top25.big5_points')!;
    expect(pts.validators.some((v) => !v.passed && v.failureStatus === 'REJECTED')).toBe(true);
  });

  it('TOP 25: an incomplete league table blocks the season', async () => {
    const k = big5(await kb());
    k.tables[2] = { ...k.tables[2]!, complete: false };
    expect(gen(k).filter((c) => c.kind === 'top25')).toHaveLength(0);
  });
});
