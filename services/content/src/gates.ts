import { normalizeAnswer } from '@ft/shared';
import type { Candidate } from './generators/index.js';
import type { GateResult, QuestionStatus } from './model.js';
import type { Entity, Fact, RawSnapshot } from './model.js';

/** The minimal knowledge-base surface the gates need (fixture and provider KBs both satisfy it). */
export interface GateKB {
  factIndex: Map<string, Fact>;
  snapshots: Map<string, RawSnapshot>;
  entities: Map<string, Entity>;
}
import { sourceById } from './sources.js';

const ok = (gate: GateResult['gate'], message: string): GateResult => ({
  gate,
  passed: true,
  failureStatus: null,
  message,
});
const fail = (gate: GateResult['gate'], failureStatus: QuestionStatus, message: string): GateResult => ({
  gate,
  passed: false,
  failureStatus,
  message,
});

/**
 * Mandatory publication gates (CONTENT_ENGINE.md, Blueprint B3). Order matters only for the
 * reported primary failure; every gate is always evaluated and recorded.
 */
export function runGates(c: Candidate, kb: GateKB, seenFingerprints: Set<string>): GateResult[] {
  const gates: GateResult[] = [];
  const facts = c.factIds.map((id) => kb.factIndex.get(id));
  // EVIDENCE: every supporting fact exists, links to an immutable snapshot, and is fully scoped.
  const missing = facts.filter((f) => !f || !kb.snapshots.has(f.evidenceId));
  const unscoped = facts.filter((f) => f && (!f.scope.competition || !f.scope.cutoff));
  if (c.factIds.length === 0 || missing.length)
    gates.push(
      fail('EVIDENCE', 'NEEDS_EVIDENCE', `${missing.length || 'No'} supporting fact(s) lack evidence`),
    );
  else if (unscoped.length)
    gates.push(fail('EVIDENCE', 'NEEDS_EVIDENCE', 'Fact scope (competition/cutoff) incomplete'));
  else
    gates.push(
      ok('EVIDENCE', `${c.factIds.length} facts, each linked to a raw snapshot with scope and cutoff`),
    );
  // TRUTH: no supporting fact may be in conflict between sources.
  const conflicted = facts.filter((f) => f?.status === 'CONFLICTED');
  gates.push(
    conflicted.length
      ? fail('TRUTH', 'QUARANTINED', `Sources disagree on ${conflicted.length} supporting fact(s)`)
      : ok('TRUTH', 'No conflicting source values'),
  );
  // LICENSING: separate from factual confidence.
  const sources = [...new Set(facts.filter(Boolean).map((f) => f!.sourceId))];
  const blocked = sources.filter((id) => {
    const s = sourceById(id);
    return !s || s.licenseStatus !== 'APPROVED' || !s.allowedUses.includes('GAMEPLAY');
  });
  gates.push(
    blocked.length
      ? fail('LICENSING', 'BLOCKED_RIGHTS', `License not approved for gameplay: ${blocked.join(', ')}`)
      : ok('LICENSING', `Rights approved: ${sources.join(', ')}`),
  );
  // IDENTITY: canonical entities exist.
  const unknown = c.entityIds.filter((id) => !kb.entities.has(id));
  gates.push(
    unknown.length
      ? fail('IDENTITY', 'NEEDS_REVIEW', `Unknown entities: ${unknown.join(', ')}`)
      : ok('IDENTITY', 'All entities resolve to canonical IDs'),
  );
  // Mode-specific validators from the generator.
  gates.push(...c.validators);
  // Leak check: the answer must not appear in pre-reveal text.
  const leaks = c.secretStrings.filter((secret) => {
    const n = normalizeAnswer(secret);
    return n.length > 2 && c.preRevealText.some((t) => ` ${normalizeAnswer(t)} `.includes(` ${n} `));
  });
  gates.push(
    leaks.length
      ? fail('CLUES', 'REJECTED', 'Pre-reveal text leaks the answer')
      : ok('CLUES', 'No answer leakage in prompts, clues or hints'),
  );
  // NOVELTY
  gates.push(
    seenFingerprints.has(c.fingerprint)
      ? fail('NOVELTY', 'DUPLICATE', 'Duplicate canonical fact fingerprint')
      : ok('NOVELTY', 'Unique fingerprint'),
  );
  return gates;
}

const PRIORITY: QuestionStatus[] = [
  'BLOCKED_RIGHTS',
  'QUARANTINED',
  'NEEDS_EVIDENCE',
  'REJECTED',
  'DUPLICATE',
  'NEEDS_REVIEW',
];

export function primaryFailure(gates: GateResult[]): QuestionStatus | null {
  const failed = gates.filter((g) => !g.passed).map((g) => g.failureStatus!);
  for (const s of PRIORITY) if (failed.includes(s)) return s;
  return null;
}
