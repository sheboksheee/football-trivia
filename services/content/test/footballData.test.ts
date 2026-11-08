import { describe, expect, it } from 'vitest';
import {
  FootballDataClient,
  ingestFootballData,
  normalizeFootballData,
  runPipeline,
  setSourceLicense,
  sourceById,
  hasCommercialRights,
  LicenseError,
  FOOTBALL_DATA_SOURCE_ID,
  SYNTHETIC_SOURCE_ID,
  footballDataAdapter,
  type FetchLike,
  type RawSnapshot,
} from '../src/index.js';

import { fakeApi, fakeClock, seasonData } from './fdFake.js';
import { snapshot, generateFootballDataCandidates } from '../src/index.js';

async function ingest(seasons = [2024, 2025, 2026]) {
  const api = fakeApi();
  const clock = fakeClock();
  const client = new FootballDataClient({ token: 'test-token', fetch: api.f, ...clock });
  const report = await ingestFootballData(client, { competitions: ['FPL'], seasons });
  return { report, api, clock };
}

describe('football-data.org client', () => {
  it('authenticates with X-Auth-Token and spaces calls for the free-plan limit (10/min)', async () => {
    const { report, api, clock } = await ingest([2025]);
    expect(report.snapshots).toHaveLength(3);
    expect(api.seen.every((s) => s.headers['X-Auth-Token'] === 'test-token')).toBe(true);
    expect(api.seen[0]!.url).toBe('https://api.football-data.org/v4/competitions/FPL/matches?season=2025');
    expect(clock.sleeps.filter((x) => x > 0).every((x) => x >= 6000)).toBe(true);
    expect(
      report.snapshots.every((s) => /^[0-9a-f]{64}$/.test(s.hash) && s.sourceId === FOOTBALL_DATA_SOURCE_ID),
    ).toBe(true);
  });
  it('waits for the documented reset header on 429 and retries', async () => {
    const api = fakeApi({ rateLimitOnce: true });
    const clock = fakeClock();
    const r = await new FootballDataClient({ fetch: api.f, ...clock }).matches('FPL', 2025);
    expect(r.ok).toBe(true);
    expect(clock.sleeps).toContain(7000);
  });
  it('skips competitions outside the plan (403) and stops on bad credentials (401)', async () => {
    const forbidden = await ingestFootballData(
      new FootballDataClient({ fetch: fakeApi({ forbid: ['XYZ'] }).f, ...fakeClock() }),
      { competitions: ['XYZ', 'FPL'], seasons: [2025] },
    );
    expect(forbidden.skipped).toEqual([expect.objectContaining({ status: 403, reason: 'NOT_IN_PLAN' })]);
    expect(forbidden.snapshots).toHaveLength(3);
    const bad = await ingestFootballData(
      new FootballDataClient({ fetch: fakeApi({ unauthorized: true }).f, ...fakeClock() }),
      { competitions: ['FPL', 'XYZ'], seasons: [2024, 2025] },
    );
    expect(bad.calls).toBe(1);
    expect(bad.skipped[0]!.reason).toBe('UNAUTHORIZED');
  });
  it('treats an anonymous 403 as a missing/invalid token and stops', async () => {
    const f: FetchLike = async () => ({
      status: 403,
      headers: { get: (n: string) => (n === 'X-Authenticated-Client' ? 'anonymous' : null) },
      json: async () => ({}),
    });
    const r = await ingestFootballData(new FootballDataClient({ fetch: f, ...fakeClock() }), {
      competitions: ['PL', 'PD'],
      seasons: [2024, 2025],
    });
    expect(r.calls).toBe(1);
    expect(r.skipped[0]!.reason).toBe('UNAUTHORIZED');
  });
  it('reports network failures instead of crashing, and stops the run', async () => {
    const f: FetchLike = async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND api.football-data.org'),
      });
    };
    const r = await ingestFootballData(new FootballDataClient({ fetch: f, ...fakeClock() }), {
      competitions: ['PL', 'PD'],
      seasons: [2024],
    });
    expect(r.calls).toBe(1);
    expect(r.skipped[0]).toMatchObject({
      reason: 'NETWORK',
      detail: 'getaddrinfo ENOTFOUND api.football-data.org',
    });
  });
  it('never re-fetches snapshots it already has', async () => {
    const { report } = await ingest([2025]);
    const api = fakeApi();
    const again = await ingestFootballData(new FootballDataClient({ fetch: api.f, ...fakeClock() }), {
      competitions: ['FPL'],
      seasons: [2025],
      have: new Set(report.snapshots.map((s) => s.id)),
    });
    expect(again.calls).toBe(0);
  });
  it('implements the provider adapter contract', async () => {
    const ad = footballDataAdapter(
      new FootballDataClient({ fetch: fakeApi().f, ...fakeClock() }),
      ['FPL'],
      [2025],
    );
    expect(await ad.fetchLineups()).toEqual({ status: 'NOT_SUPPORTED' });
    expect(((await ad.fetchMatches()) as RawSnapshot[]).length).toBe(1);
  });
});

describe('football-data normalisation', () => {
  it('uses only FINISHED matches and marks unfinished seasons incomplete', async () => {
    const { report } = await ingest();
    const kb = normalizeFootballData(report.snapshots, '2026-11-08');
    expect(kb.invalid).toEqual([]);
    expect(kb.matches.every((m) => Number.isInteger(m.homeGoals))).toBe(true);
    expect(kb.matches.filter((m) => m.season === '2026/27')).toHaveLength(10); // only finished ones
    expect(kb.tables.find((t) => t.season === '2025/26')!.complete).toBe(true);
    expect(kb.tables.find((t) => t.season === '2026/27')!.complete).toBe(false);
    expect(kb.teams.get('fd_team_9000')!.venue).toBe('Alder Park');
    expect(kb.facts.every((f) => kb.snapshots.has(f.evidenceId) && f.scope.cutoff)).toBe(true);
  });
  it('a finished season with an AWARDED match is complete, and affected table questions are flagged', () => {
    const d = seasonData(2025, true);
    const m0 = d.matches.matches[0] as any;
    m0.status = 'AWARDED';
    const awarded = [m0.homeTeam.id, m0.awayTeam.id];
    for (const r of d.standings.standings[0]!.table as any[])
      if (awarded.includes(r.team.id)) r.playedGames -= 1;
    const at = '2026-11-08T00:00:00.000Z';
    const snaps = (['matches', 'standings', 'teams'] as const).map((k) =>
      snapshot(FOOTBALL_DATA_SOURCE_ID, `fd_${k}`, `FPL_2025`, d[k], at),
    );
    const kb = normalizeFootballData(snaps, '2026-11-08');
    const table = kb.tables[0]!;
    expect(table.complete).toBe(true);
    expect(table.awardedTeams.sort()).toEqual(awarded.map((x: number) => `fd_team_${x}`).sort());
    expect(kb.matches.some((m) => m.entityId === `fd_match_${m0.id}`)).toBe(false); // awarded result never used as a played score
    const cands = generateFootballDataCandidates(kb, { today: '2026-11-08' });
    const hl = cands.filter((c) => c.template.startsWith('fd.hl.'));
    const flagged = hl.filter((c) => c.validators.some((v) => v.message.includes('awarded')));
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((c) => c.entityIds.some((e) => table.awardedTeams.includes(e)))).toBe(true);
    expect(
      flagged.every(
        (c) => c.validators.find((v) => v.message.includes('awarded'))!.failureStatus === 'NEEDS_REVIEW',
      ),
    ).toBe(true);
    // Stadium questions always carry the "names can be outdated" review note
    const venue = cands.filter((c) => c.template.includes('venue'));
    expect(venue.length).toBeGreaterThan(0);
    expect(venue.every((c) => c.validators.some((v) => v.message.startsWith('Stadium names')))).toBe(true);
  });
  it('records malformed payloads instead of trusting them', () => {
    const bad: RawSnapshot = {
      id: 'x',
      sourceId: FOOTBALL_DATA_SOURCE_ID,
      retrievedAt: '2026-11-08T00:00:00Z',
      recordType: 'fd_standings',
      externalId: 'x',
      payload: { nope: true },
      hash: '0'.repeat(64),
    };
    expect(normalizeFootballData([bad], '2026-11-08').invalid).toHaveLength(1);
  });
});

describe('licensing and publication of real-provider questions', () => {
  it('license decisions are validated and audited; fixtures are fixed', () => {
    expect(() =>
      setSourceLicense(SYNTHETIC_SOURCE_ID, { status: 'PENDING', allowedUses: [], by: 'a', note: 'x x x' }),
    ).toThrow(LicenseError);
    expect(() =>
      setSourceLicense(FOOTBALL_DATA_SOURCE_ID, {
        status: 'APPROVED',
        allowedUses: ['GAMEPLAY'],
        by: 'a',
        note: '',
      }),
    ).toThrow(/note/);
    expect(() =>
      setSourceLicense(FOOTBALL_DATA_SOURCE_ID, {
        status: 'APPROVED',
        allowedUses: [],
        by: 'a',
        note: 'evidence',
      }),
    ).toThrow(/GAMEPLAY/);
    expect(() =>
      setSourceLicense(FOOTBALL_DATA_SOURCE_ID, {
        status: 'PENDING',
        allowedUses: ['GAMEPLAY'],
        by: 'a',
        note: 'evidence',
      }),
    ).toThrow(/APPROVED/);
  });

  it('PENDING license blocks every question; approval sends them to human review, never auto-publish', async () => {
    const { report } = await ingest();
    const opts = { footballData: report.snapshots, today: '2026-11-08' };
    const blocked = runPipeline(undefined, undefined, opts)
      .bank.all()
      .filter((q) => q.sourceIds.includes(FOOTBALL_DATA_SOURCE_ID));
    expect(blocked.length).toBeGreaterThan(20);
    expect(
      blocked.every(
        (q) => q.status === 'BLOCKED_RIGHTS' || q.status === 'REJECTED' || q.status === 'DUPLICATE',
      ),
    ).toBe(true);

    setSourceLicense(FOOTBALL_DATA_SOURCE_ID, {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY'],
      by: 'owner',
      note: 'Private testing on the free plan',
    });
    expect(hasCommercialRights(FOOTBALL_DATA_SOURCE_ID)).toBe(false);
    expect(sourceById(FOOTBALL_DATA_SOURCE_ID)!.licenseHistory).toHaveLength(1);
    const run = runPipeline(undefined, undefined, opts);
    const fd = run.bank.all().filter((q) => q.sourceIds.includes(FOOTBALL_DATA_SOURCE_ID));
    expect(fd.some((q) => q.status === 'PUBLISHED')).toBe(false);
    const review = fd.filter((q) => q.status === 'NEEDS_REVIEW');
    const templates = new Set(review.map((q) => q.template));
    for (const t of [
      'fd.mcq.champion',
      'fd.hl.points',
      'fd.mcq.match_score',
      'fd.tl.match_order',
      'fd.gm.fixture',
      'fd.sa.club_by_venue',
      'fd.mcq.home_venue',
    ])
      expect(templates).toContain(t);
    // Champion questions only for complete seasons
    const champs = review.filter((q) => q.template === 'fd.mcq.champion');
    expect(champs.map((q) => (q.item as { prompt: string }).prompt).join()).not.toContain('2026/27');
    for (const q of review)
      expect(q.item.meta.attribution).toBe('Football data provided by the Football-Data.org API');
    for (const q of review.filter((x) => x.item.kind === 'higher_lower'))
      if (q.item.kind === 'higher_lower') expect(q.item.a.value).not.toBe(q.item.b.value);
    // Human approval publishes; ids are stable across re-runs so reviews survive re-ingestion
    const one = review[0]!;
    expect(run.bank.review(one.id, 'APPROVE', 'owner', 'checked the source').status).toBe('PUBLISHED');
    const rerun = runPipeline(undefined, undefined, opts);
    expect(rerun.bank.get(one.id)?.fingerprint).toBe(one.fingerprint);
    // Fixture content is unaffected
    expect(rerun.bank.all().filter((q) => q.status === 'PUBLISHED').length).toBeGreaterThan(500);
  });
});
