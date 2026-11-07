import type { ContentItem } from '@ft/shared';
import { QuestionBank } from './bank.js';
import { estimateDifficulty } from './difficulty.js';
import { fixtureSnapshots, generateLeague } from './fixture.js';
import { primaryFailure, runGates } from './gates.js';
import { generateCandidates } from './generators/index.js';
import { HIGH_IMPACT_KINDS, KIND_TO_MODES, type Question } from './model.js';
import { normalize, verify, type ConflictReport, type KnowledgeBase } from './normalize.js';
import { sourceById } from './sources.js';

export interface PublishPolicy {
  /** Auto-publish candidates whose every source is autoApproveEligible (fictional fixtures only). */
  autoApproveFixtures: boolean;
  /** Also auto-publish high-impact kinds (rankings, kickoff XIs) from fixtures. Dev convenience only. */
  autoApproveHighImpact: boolean;
}

export const DEV_POLICY: PublishPolicy = { autoApproveFixtures: true, autoApproveHighImpact: true };
export const STRICT_POLICY: PublishPolicy = { autoApproveFixtures: false, autoApproveHighImpact: false };

export interface PipelineResult {
  bank: QuestionBank;
  kb: KnowledgeBase;
  conflicts: ConflictReport[];
}

/**
 * INGEST -> NORMALIZE -> VERIFY -> GENERATE -> VALIDATE -> DIFFICULTY -> REVIEW/PUBLISH.
 * Never generates and publishes unsupported content: auto-publication requires every gate to
 * pass AND every source to be an eligible fixture under the active policy.
 */
export function runPipeline(policy: PublishPolicy = DEV_POLICY, at = '2026-11-01T00:00:00.000Z'): PipelineResult {
  const league = generateLeague();
  const snaps = fixtureSnapshots(league, at);
  const kb = normalize(snaps);
  const conflicts = verify(kb);
  const candidates = generateCandidates(kb);
  const seen = new Set<string>();
  const questions: Question[] = [];
  candidates.forEach((c, i) => {
    const gates = runGates(c, kb, seen);
    seen.add(c.fingerprint);
    const sourceIds = [...new Set(c.factIds.map((id) => kb.factIndex.get(id)?.sourceId).filter((x): x is string => !!x))];
    const difficulty = estimateDifficulty(c.components);
    const failure = primaryFailure(gates);
    const highImpact = HIGH_IMPACT_KINDS.includes(c.kind);
    const eligible = sourceIds.every((s) => sourceById(s)?.autoApproveEligible);
    let status: Question['status'] = failure ?? 'NEEDS_REVIEW';
    let note = failure ? `Gate failure: ${failure}` : 'All gates passed; awaiting human review';
    if (!failure && eligible && policy.autoApproveFixtures && (!highImpact || policy.autoApproveHighImpact)) {
      status = 'PUBLISHED';
      note = 'Auto-published: fictional fixture source under development policy';
    }
    const id = `q_${c.kind}_${c.fingerprint.slice(0, 12)}_${i}`;
    const attribution = sourceIds.map((s) => sourceById(s)?.attribution ?? s).join('; ');
    const item = {
      ...c.item,
      meta: { questionId: id, version: 1, difficulty: difficulty.tier, difficultyStatus: difficulty.status, attribution, sourceIds, evidenceIds: [...new Set(c.factIds.map((f) => kb.factIndex.get(f)?.evidenceId ?? ''))].slice(0, 50) },
    } as ContentItem;
    questions.push({
      id, kind: c.kind, modes: KIND_TO_MODES[c.kind], version: 1, status, template: c.template, item,
      factIds: c.factIds, sourceIds, fingerprint: c.fingerprint, highImpact, gates, difficulty, createdAt: at,
      audit: [
        { at, actor: 'pipeline', action: 'generated', fromStatus: null, toStatus: 'CANDIDATE', note: c.template },
        { at, actor: 'pipeline', action: 'gated', fromStatus: 'CANDIDATE', toStatus: status, note },
      ],
    });
  });
  return { bank: new QuestionBank(questions), kb, conflicts };
}
