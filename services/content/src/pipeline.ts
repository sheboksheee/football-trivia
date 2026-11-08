import type { ContentItem } from '@ft/shared';
import { QuestionBank } from './bank.js';
import { estimateDifficulty } from './difficulty.js';
import { fixtureSnapshots, generateLeague } from './fixture.js';
import { primaryFailure, runGates } from './gates.js';
import { generateCandidates } from './generators/index.js';
import { HIGH_IMPACT_KINDS, KIND_TO_MODES, type Question } from './model.js';
import { normalize, verify, type ConflictReport, type KnowledgeBase } from './normalize.js';
import { sourceById } from './sources.js';
import {
  generateFootballDataCandidates,
  normalizeFootballData,
  type FdKB,
} from './providers/footballDataContent.js';
import type { RawSnapshot } from './model.js';
import type { GateKB } from './gates.js';

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
  /** Real-provider knowledge base (football-data.org), when snapshots were supplied. */
  fdKb: FdKB | null;
}

export interface PipelineInputs {
  /** Stored football-data.org snapshots (immutable provenance). */
  footballData?: RawSnapshot[];
  /** ISO date used to decide which seasons are complete. */
  today?: string;
}

/**
 * INGEST -> NORMALIZE -> VERIFY -> GENERATE -> VALIDATE -> DIFFICULTY -> REVIEW/PUBLISH.
 * Never generates and publishes unsupported content: auto-publication requires every gate to
 * pass AND every source to be an eligible fixture under the active policy.
 */
export function runPipeline(
  policy: PublishPolicy = DEV_POLICY,
  at = '2026-11-01T00:00:00.000Z',
  inputs: PipelineInputs = {},
): PipelineResult {
  const league = generateLeague();
  const snaps = fixtureSnapshots(league, at);
  const kb = normalize(snaps);
  const conflicts = verify(kb);
  const today = inputs.today ?? new Date().toISOString().slice(0, 10);
  const fdKb = inputs.footballData?.length ? normalizeFootballData(inputs.footballData, today) : null;
  const groups: Array<{
    kb: GateKB;
    candidates: ReturnType<typeof generateCandidates>;
    idPrefix: (i: number, fp: string, kind: string) => string;
  }> = [
    { kb, candidates: generateCandidates(kb), idPrefix: (i, f, kind) => `q_${kind}_${f.slice(0, 12)}_${i}` },
  ];
  // Provider question ids depend only on the fact fingerprint, so human reviews survive re-ingestion.
  if (fdKb)
    groups.push({
      kb: fdKb,
      candidates: generateFootballDataCandidates(fdKb, { today }),
      idPrefix: (_i, f) => `q_fd_${f.slice(0, 16)}`,
    });
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const group of groups)
    group.candidates.forEach((c, i) => {
      const kb = group.kb;
      const gates = runGates(c, kb, seen);
      seen.add(c.fingerprint);
      const sourceIds = [
        ...new Set(c.factIds.map((id) => kb.factIndex.get(id)?.sourceId).filter((x): x is string => !!x)),
      ];
      const difficulty = estimateDifficulty(c.components);
      const failure = primaryFailure(gates);
      const highImpact = HIGH_IMPACT_KINDS.includes(c.kind);
      const eligible = sourceIds.every((s) => sourceById(s)?.autoApproveEligible);
      let status: Question['status'] = failure ?? 'NEEDS_REVIEW';
      let note = failure ? `Gate failure: ${failure}` : 'All gates passed; awaiting human review';
      if (
        !failure &&
        eligible &&
        policy.autoApproveFixtures &&
        (!highImpact || policy.autoApproveHighImpact)
      ) {
        status = 'PUBLISHED';
        note = 'Auto-published: fictional fixture source under development policy';
      }
      const id = group.idPrefix(i, c.fingerprint, c.kind);
      const attribution = sourceIds.map((s) => sourceById(s)?.attribution ?? s).join('; ');
      const item = {
        ...c.item,
        meta: {
          questionId: id,
          version: 1,
          difficulty: difficulty.tier,
          difficultyStatus: difficulty.status,
          attribution,
          sourceIds,
          evidenceIds: [...new Set(c.factIds.map((f) => kb.factIndex.get(f)?.evidenceId ?? ''))].slice(0, 50),
        },
      } as ContentItem;
      questions.push({
        id,
        kind: c.kind,
        modes: KIND_TO_MODES[c.kind],
        version: 1,
        status,
        template: c.template,
        item,
        factIds: c.factIds,
        sourceIds,
        fingerprint: c.fingerprint,
        highImpact,
        gates,
        difficulty,
        createdAt: at,
        audit: [
          {
            at,
            actor: 'pipeline',
            action: 'generated',
            fromStatus: null,
            toStatus: 'CANDIDATE',
            note: c.template,
          },
          { at, actor: 'pipeline', action: 'gated', fromStatus: 'CANDIDATE', toStatus: status, note },
        ],
      });
    });
  return { bank: new QuestionBank(questions), kb, conflicts, fdKb };
}
