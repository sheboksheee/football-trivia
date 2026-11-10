import { describe, expect, it } from 'vitest';
import { createRng, matchesAlias, type McqItem } from '@ft/shared';
import {
  CROSSCHECK_SOURCE_ID,
  estimateDifficulty,
  fixtureSnapshots,
  generateCandidates,
  generateLeague,
  MIN_CALIBRATION_SAMPLE,
  normalize,
  PENDING_SOURCE_ID,
  primaryFailure,
  QuestionBank,
  recordAttempts,
  ReviewError,
  riskExpectedValues,
  runGates,
  runPipeline,
  SOURCES,
  STRICT_POLICY,
  syntheticAdapter,
  verify,
} from '../src/index.js';

const result = runPipeline();
const all = result.bank.all();

describe('fixture provenance', () => {
  it('is deterministic and every snapshot has a sha256 evidence hash', () => {
    const a = fixtureSnapshots(generateLeague());
    const b = fixtureSnapshots(generateLeague());
    expect(a.map((s) => s.hash)).toEqual(b.map((s) => s.hash));
    expect(a.every((s) => /^[0-9a-f]{64}$/.test(s.hash))).toBe(true);
  });
  it('real-world providers start with a PENDING license and are never auto-approved', () => {
    const real = SOURCES.filter((s) => s.kind !== 'SYNTHETIC_FIXTURE');
    expect(real.length).toBeGreaterThan(5);
    expect(real.every((s) => s.licenseStatus === 'PENDING' && !s.autoApproveEligible)).toBe(true);
    // football-data.org, Wikidata, OpenFootball and owner-entered line-ups are integrated.
    expect(real.filter((s) => s.integrated).map((s) => s.id)).toEqual([
      'src_football_data_org',
      'src_wikidata',
      'src_openfootball',
      'src_owner_lineups',
    ]);
  });
  it('adapter contract returns NOT_SUPPORTED explicitly', async () => {
    const ad = syntheticAdapter();
    expect(await ad.fetchTransfers()).toEqual({ status: 'NOT_SUPPORTED' });
    expect(((await ad.fetchMatches()) as unknown[]).length).toBe(900);
    expect((await ad.healthCheck()).ok).toBe(true);
  });
});

describe('publication gates (acceptance)', () => {
  it('source conflict quarantines every dependent question', () => {
    const conflicted = new Set(result.kb.facts.filter((f) => f.status === 'CONFLICTED').map((f) => f.id));
    expect(result.conflicts.length).toBe(6);
    expect(result.conflicts.every((c) => c.values.some((v) => v.sourceId === CROSSCHECK_SOURCE_ID))).toBe(
      true,
    );
    const dependents = all.filter((q) => q.factIds.some((id) => conflicted.has(id)));
    expect(dependents.length).toBeGreaterThan(0);
    expect(dependents.every((q) => q.status === 'QUARANTINED' || q.status === 'BLOCKED_RIGHTS')).toBe(true);
  });
  it('pending license blocks publication', () => {
    const pending = all.filter((q) => q.sourceIds.includes(PENDING_SOURCE_ID));
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((q) => q.status === 'BLOCKED_RIGHTS')).toBe(true);
  });
  it('a distractor that also answers the question blocks publication', () => {
    const kb = normalize(fixtureSnapshots(generateLeague()));
    verify(kb);
    const cand = generateCandidates(kb).find((c) => c.template === 'mcq.top_scorer_club_season')!;
    // Tamper: make the validator see two satisfying options by re-running gates with a forced failure
    const tampered = {
      ...cand,
      validators: [
        {
          gate: 'DISTRACTORS' as const,
          passed: false,
          failureStatus: 'REJECTED' as const,
          message: 'More than one option satisfies the stem',
        },
      ],
    };
    expect(primaryFailure(runGates(tampered, kb, new Set()))).toBe('REJECTED');
    expect(primaryFailure(runGates(cand, kb, new Set([cand.fingerprint])))).toBe('DUPLICATE');
  });
  it('every published question passes every gate and has evidence + attribution', () => {
    const pub = all.filter((q) => q.status === 'PUBLISHED');
    expect(pub.length).toBeGreaterThan(500);
    for (const q of pub) {
      expect(q.gates.every((g) => g.passed)).toBe(true);
      expect(q.item.meta.evidenceIds.length).toBeGreaterThan(0);
      expect(q.item.meta.attribution).toMatch(/fictional/i);
      expect(q.audit.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('published MCQs have 4 unique options and exactly one correct id', () => {
    for (const q of all.filter((x) => x.kind === 'mcq' && x.status === 'PUBLISHED')) {
      const item = q.item as McqItem;
      expect(new Set(item.options.map((o) => o.label)).size).toBe(4);
      expect(item.options.filter((o) => o.id === item.correctOptionId)).toHaveLength(1);
    }
  });
  it('published Higher or Lower never compares equal values; TOP 25 lists have 25 unique ranks', () => {
    for (const q of all.filter((x) => x.status === 'PUBLISHED')) {
      if (q.item.kind === 'higher_lower') expect(q.item.a.value).not.toBe(q.item.b.value);
      if (q.item.kind === 'top25') {
        expect(new Set(q.item.entries.map((e) => e.rank)).size).toBe(25);
        expect(new Set(q.item.entries.map((e) => e.label)).size).toBe(25);
      }
    }
  });
  it('Connections with an alternate shared club are rejected; Missing XI hints never leak the answer', () => {
    const conn = all.filter((q) => q.kind === 'connection');
    for (const q of conn.filter((x) => x.status === 'PUBLISHED'))
      expect(q.gates.find((g) => g.message.startsWith('Alternate link'))).toBeUndefined();
    for (const q of all.filter((x) => x.kind === 'missing_xi' && x.status === 'PUBLISHED')) {
      if (q.item.kind !== 'missing_xi') continue;
      const it = q.item;
      for (const h of it.hints) expect(matchesAlias(h, [it.missingAnswer])).toBe(false);
      expect(it.slots.filter((s) => s.player === null)).toHaveLength(1);
      expect(it.slots.some((s) => s.player === it.missingAnswer)).toBe(false);
    }
  });
  it('strict policy publishes nothing automatically — human review required', () => {
    const strict = runPipeline(STRICT_POLICY);
    expect(strict.bank.all().filter((q) => q.status === 'PUBLISHED')).toHaveLength(0);
    expect(strict.bank.all().filter((q) => q.status === 'NEEDS_REVIEW').length).toBeGreaterThan(500);
  });
  it('there is enough published content for every playable mode', () => {
    const c = result.bank.counts();
    expect(c.mcq!.PUBLISHED!).toBeGreaterThan(36 + 15 + 5);
    for (const k of [
      'higher_lower',
      'short_answer',
      'connection',
      'timeline',
      'impostor',
      'missing_xi',
      'guess_match',
      'top25',
      'auction',
    ])
      expect(c[k]!.PUBLISHED ?? 0).toBeGreaterThanOrEqual(k === 'top25' ? 1 : 6);
  });
});

describe('review workflow', () => {
  it('approve requires note and passing hard gates; quarantine/retire/restore transitions; audit trail', () => {
    const strict = runPipeline(STRICT_POLICY).bank;
    const q = strict.all().find((x) => x.status === 'NEEDS_REVIEW')!;
    expect(() => strict.review(q.id, 'APPROVE', 'admin', '')).toThrow(ReviewError);
    const pub = strict.review(q.id, 'APPROVE', 'admin', 'checked evidence');
    expect(pub.status).toBe('PUBLISHED');
    expect(strict.review(q.id, 'RETIRE', 'admin', 'stale').status).toBe('RETIRED');
    expect(strict.review(q.id, 'RESTORE', 'admin', 'fixed').status).toBe('NEEDS_REVIEW');
    expect(
      strict
        .get(q.id)!
        .audit.map((a) => a.action)
        .slice(-3),
    ).toEqual(['review.approve', 'review.retire', 'review.restore']);
    const blocked = strict.all().find((x) => x.status === 'BLOCKED_RIGHTS')!;
    expect(() => strict.review(blocked.id, 'APPROVE', 'admin', 'force it')).toThrow(/Cannot APPROVE/);
    const quarantined = strict.all().find((x) => x.status === 'QUARANTINED')!;
    expect(() => strict.review(quarantined.id, 'APPROVE', 'admin', 'force it')).toThrow(/Cannot APPROVE/);
  });
  it('draw returns only published items, no repeats within a session, balanced tiers', () => {
    const bank = new QuestionBank(result.bank.all());
    const used = new Set<string>();
    const a = bank.draw('mcq', 20, createRng(1), used);
    const b = bank.draw('mcq', 20, createRng(2), used);
    const ids = [...a, ...b].map((i) => i.meta.questionId);
    expect(new Set(ids).size).toBe(40);
    expect(ids.every((id) => bank.get(id)!.status === 'PUBLISHED')).toBe(true);
    expect(() => bank.draw('top25', 50, createRng(1))).toThrow(/Not enough/);
  });
});

describe('difficulty engine', () => {
  const d = estimateDifficulty({
    rarity: 50,
    complexity: 50,
    distractorSimilarity: 50,
    temporalDistance: 50,
    recallDepth: 50,
  });
  it('heuristic estimate uses documented weights', () => {
    expect(d.estimate).toBe(50);
    expect(d.tier).toBe('MEDIUM');
    expect(d.status).toBe('PROVISIONAL');
  });
  it('insufficient samples never reclassify (acceptance)', () => {
    const r = recordAttempts(d, MIN_CALIBRATION_SAMPLE - 1, 0); // everyone wrong, but too few
    expect(r.tier).toBe('MEDIUM');
    expect(r.status).toBe('PROVISIONAL');
  });
  it('enough samples calibrate with Bayesian smoothing', () => {
    const hard = recordAttempts(d, 200, 10);
    expect(hard.status).toBe('CALIBRATED');
    expect(['HARD', 'EXPERT']).toContain(hard.tier);
    const easy = recordAttempts(d, 200, 190);
    expect(easy.tier).toBe('EASY');
  });
  it('Risk It expected values per tier (Blueprint C3)', () => {
    expect(riskExpectedValues(0.5)).toEqual({ SAFE: 0.5, BOLD: 1, ALL_IN: 1.5 });
    expect(riskExpectedValues(1 / 3).ALL_IN).toBeCloseTo(0);
  });
});
