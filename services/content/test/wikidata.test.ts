import { afterEach, describe, expect, it } from 'vitest';
import { matchesAlias, type ConnectionItem, type ImpostorItem, type McqItem } from '@ft/shared';
import {
  WikidataClient,
  ingestWikidata,
  normalizeWikidata,
  generateWikidataCandidates,
  resolveClubs,
  plausibleArabic,
  runPipeline,
  setSourceLicense,
  sourceById,
  WIKIDATA_SOURCE_ID,
  WD_USER_AGENT,
  type RawSnapshot,
} from '../src/index.js';
import { fakeClock } from './fdFake.js';
import { CLUB_QID, fakeWikidata, PLAYERS, WD_TEAMS } from './wdFake.js';

async function ingest(opts: Parameters<typeof fakeWikidata>[0] = {}, have = new Map<string, RawSnapshot>()) {
  const api = fakeWikidata(opts);
  const clock = fakeClock();
  const client = new WikidataClient({ fetch: api.f, ...clock, maxRetries: 0 });
  const report = await ingestWikidata(client, {
    teams: WD_TEAMS,
    have,
    now: () => '2026-11-09T00:00:00.000Z',
  });
  return { report, api, clock };
}

const resetLicense = () => {
  const s = sourceById(WIKIDATA_SOURCE_ID)!;
  s.licenseStatus = 'PENDING';
  s.allowedUses = [];
  s.licenseHistory = [];
};
afterEach(resetLicense);

describe('Wikidata client and ingestion', () => {
  it('identifies itself per the Wikimedia User-Agent policy (no personal e-mail) and spaces calls', async () => {
    const { api, clock, report } = await ingest();
    expect(api.seen.every((s) => s.headers['user-agent'] === WD_USER_AGENT)).toBe(true);
    expect(WD_USER_AGENT).not.toMatch(/@/);
    expect(clock.sleeps.filter((x) => x > 0).every((x) => x >= 900)).toBe(true);
    // 5 searches + 1 validation batch + 5 club player lists
    expect(report.calls).toBe(11);
    expect(
      report.snapshots.every((s) => s.sourceId === WIKIDATA_SOURCE_ID && /^[0-9a-f]{64}$/.test(s.hash)),
    ).toBe(true);
  });

  it('re-uses stored snapshots: a second run makes no calls', async () => {
    const first = await ingest();
    const have = new Map(first.report.snapshots.map((s) => [s.id, s]));
    const second = await ingest({}, have);
    expect(second.report.calls).toBe(0);
  });

  it('stops on network failure (host blocked) instead of looping', async () => {
    const { report } = await ingest({ down: true });
    expect(report.calls).toBe(1);
    expect(report.skipped[0]!.reason).toBe('NETWORK');
  });

  it('a failing club list is skipped, the rest still loads', async () => {
    const { report } = await ingest({ failPlayersFor: CLUB_QID['Cedar Town'] });
    expect(report.skipped.map((s) => s.what)).toEqual([`players ${CLUB_QID['Cedar Town']}`]);
    expect(report.snapshots.filter((s) => s.recordType === 'wd_club_players')).toHaveLength(4);
  });
});

describe('club resolution', () => {
  it("skips women's/youth sides and non-club hits, never guesses", async () => {
    const { report } = await ingest({ womenFirst: ['Alder FC'] });
    const searches = report.snapshots.filter((s) => s.recordType === 'wd_search');
    const clubs = report.snapshots.filter((s) => s.recordType === 'wd_clubs');
    const r = resolveClubs(searches, clubs);
    expect(r.get(9000)!.qid).toBe(CLUB_QID['Alder FC']);
    expect(r.size).toBe(5);
  });

  it('a duplicate/stub club item ranked first by search loses to the well-linked club', async () => {
    const { report } = await ingest({ stubFirst: ['Elm City'] });
    const r = resolveClubs(
      report.snapshots.filter((s) => s.recordType === 'wd_search'),
      report.snapshots.filter((s) => s.recordType === 'wd_clubs'),
    );
    expect(r.get(9004)!.qid).toBe(CLUB_QID['Elm City']);
  });

  it('two football-data clubs resolving to the same item are both dropped (ambiguous)', async () => {
    const { report } = await ingest();
    const searches = report.snapshots.filter((s) => s.recordType === 'wd_search');
    const dupe = structuredClone(searches[1]!);
    (dupe.payload as { team: { fdId: number } }).team.fdId = 9999;
    (dupe.payload as { results: Array<{ id: string }> }).results[0]!.id = CLUB_QID['Alder FC']!;
    const r = resolveClubs(
      [...searches, dupe],
      report.snapshots.filter((s) => s.recordType === 'wd_clubs'),
    );
    expect(r.has(9000)).toBe(false);
    expect(r.has(9999)).toBe(false);
    expect(r.size).toBe(4);
  });
});

describe('Wikidata questions', () => {
  async function kb() {
    const { report } = await ingest();
    return normalizeWikidata(report.snapshots);
  }

  it('every membership is a scoped fact linked to its snapshot', async () => {
    const k = await kb();
    expect(k.players.size).toBe(PLAYERS.length);
    expect(k.facts).toHaveLength(18);
    for (const f of k.facts) {
      expect(k.snapshots.has(f.evidenceId)).toBe(true);
      expect(f.scope.cutoff).toBe('2026-11-09');
      expect(f.predicate).toBe('member_of_sports_team');
    }
  });

  it('Impostor: only very famous players, Arabic name, guessable in Arabic, English or by surname', async () => {
    const c = generateWikidataCandidates(await kb()).filter((x) => x.kind === 'impostor');
    expect(c).toHaveLength(PLAYERS.filter((p) => p.sl >= 60).length);
    const aron = c.find((x) => (x.item as ImpostorItem).footballer === 'آرون فيل')!.item as ImpostorItem;
    expect(aron.context).toContain('Norland');
    for (const g of ['آرون فيل', 'Aron Vale', 'vale', 'Aron Vail'])
      expect(matchesAlias(g, [aron.footballer, ...aron.aliases])).toBe(true);
    expect(matchesAlias('Bruno Kest', [aron.footballer, ...aron.aliases])).toBe(false);
  });

  it('Connections: rejected when the four share another club or a national team', async () => {
    const k = await kb();
    const c = generateWikidataCandidates(k, { connectionsPerClub: 10 }).filter(
      (x) => x.kind === 'connection',
    );
    expect(c.length).toBeGreaterThan(0);
    const clubsOf = (name: string) =>
      new Set([...k.players.values()].find((p) => (p.ar ?? p.en) === name)!.spells.map((s) => s.club));
    for (const q of c) {
      const item = q.item as ConnectionItem;
      const sets = item.entities.map(clubsOf);
      const link = q.entityIds[0]!;
      expect(sets.every((s) => s.has(link))).toBe(true);
      const other = [...sets[0]!].some((cl) => cl !== link && sets.every((s) => s.has(cl)));
      expect(q.validators.find((v) => v.gate === 'MODE_VALIDATOR')!.passed).toBe(!other);
      // the answer is never shown before the reveal
      expect(q.preRevealText.join(' ')).not.toContain(item.link);
    }
    // Birch United quartets drawn only from Elm City players are alternate-link failures.
    expect(c.some((q) => !q.validators[0]!.passed)).toBe(true);
  });

  it('MCQ: exactly one option is a club the player has a membership statement for', async () => {
    const k = await kb();
    for (const q of generateWikidataCandidates(k).filter((x) => x.template === 'wd.mcq.played_for')) {
      const item = q.item as McqItem;
      const player = k.players.get(q.entityIds[0]!)!;
      const clubs = new Set(player.spells.map((s) => s.club));
      const optionClubs = q.entityIds.slice(1);
      expect(optionClubs.filter((cl) => clubs.has(cl))).toHaveLength(1);
      const correct = item.options.find((o) => o.id === item.correctOptionId)!;
      expect(clubs.has(optionClubs[item.options.indexOf(correct)]!)).toBe(true);
    }
  });

  it('pipeline: PENDING license blocks; approved license still needs human review (never auto-publish)', async () => {
    const { report } = await ingest();
    const blocked = runPipeline(undefined, undefined, { wikidata: report.snapshots });
    const wd = blocked.bank.all().filter((q) => q.sourceIds.includes(WIKIDATA_SOURCE_ID));
    expect(wd.length).toBeGreaterThan(0);
    expect(wd.every((q) => q.status === 'BLOCKED_RIGHTS')).toBe(true);
    expect(wd.every((q) => q.id.startsWith('q_wd_'))).toBe(true);
    setSourceLicense(WIKIDATA_SOURCE_ID, {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY', 'COMMERCIAL_REDISTRIBUTION'],
      by: 'test',
      note: 'CC0 1.0',
    });
    const open = runPipeline(undefined, undefined, { wikidata: report.snapshots });
    const wd2 = open.bank.all().filter((q) => q.sourceIds.includes(WIKIDATA_SOURCE_ID));
    expect(wd2.some((q) => q.status === 'PUBLISHED')).toBe(false);
    expect(wd2.filter((q) => q.status === 'NEEDS_REVIEW').length).toBeGreaterThan(0);
    // Same snapshots -> same ids (human reviews survive re-ingestion)
    expect(wd2.map((q) => q.id).sort()).toEqual(wd.map((q) => q.id).sort());
  });
});

describe('Wikidata data hygiene', () => {
  it('ignores vandalised or non-Arabic labels and falls back to the English name', () => {
    expect(plausibleArabic('Aron Vale', 'آرون فيل')).toBe('آرون فيل');
    expect(plausibleArabic('Aron Vale', 'آرون فيل كلمة زيادة')).toBeNull();
    expect(plausibleArabic('Aron Vale', 'Aron Vale')).toBeNull();
    expect(plausibleArabic('Aron Vale', undefined)).toBeNull();
  });

  it('a club whose player list is not loaded yet is never used as an MCQ distractor', async () => {
    const { report } = await ingest();
    const partial = report.snapshots.filter(
      (s) => !(s.recordType === 'wd_club_players' && s.externalId === CLUB_QID['Elm City']),
    );
    const k = normalizeWikidata(partial);
    expect(k.clubs.has(CLUB_QID['Elm City']!)).toBe(true);
    const elm = `wd_club_${CLUB_QID['Elm City']}`;
    expect(k.loadedClubs.has(elm)).toBe(false);
    const mcq = generateWikidataCandidates(k).filter((x) => x.template === 'wd.mcq.played_for');
    expect(mcq.length).toBeGreaterThan(0);
    expect(mcq.every((q) => !q.entityIds.includes(elm))).toBe(true);
  });

  it('fetching more clubs later keeps the ids of questions whose own facts did not change', async () => {
    const { report } = await ingest();
    const partial = report.snapshots.filter(
      (s) => !(s.recordType === 'wd_club_players' && s.externalId === CLUB_QID['Elm City']),
    );
    const fps = (snaps: typeof partial) =>
      new Set(generateWikidataCandidates(normalizeWikidata(snaps)).map((c) => c.fingerprint));
    const before = fps(partial);
    const after = fps(report.snapshots);
    // Dario Moss only ever played for Alder FC: his questions are identical either way.
    const moss = generateWikidataCandidates(normalizeWikidata(partial)).filter((c) =>
      c.entityIds.includes('wd_player_Q920003'),
    );
    expect(moss.length).toBeGreaterThan(0);
    expect(moss.every((c) => after.has(c.fingerprint))).toBe(true);
    expect(before.size).toBeGreaterThan(0);
  });
});
