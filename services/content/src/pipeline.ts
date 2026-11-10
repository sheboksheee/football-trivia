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
import { generateWikidataCandidates, normalizeWikidata, type WdKB } from './providers/wikidata.js';
import { crossCheckOpenFootball, type CrossCheckReport } from './providers/openFootball.js';
import {
  generateManualLineupCandidates,
  manualIdPrefix,
  normalizeManualLineups,
  type ManualKB,
} from './providers/manualLineups.js';
import type { Candidate } from './generators/index.js';
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
  /** Wikidata knowledge base (club careers), when snapshots were supplied. */
  wdKb: WdKB | null;
  /** OpenFootball cross-check of football-data.org scores. */
  crossCheck: CrossCheckReport | null;
  /** Owner-entered line-ups (Missing XI). */
  manualKb: ManualKB | null;
}

export interface PipelineInputs {
  /** Stored football-data.org snapshots (immutable provenance). */
  footballData?: RawSnapshot[];
  /** Stored Wikidata snapshots. */
  wikidata?: RawSnapshot[];
  /** Stored OpenFootball snapshots (cross-check only). */
  openFootball?: RawSnapshot[];
  /** Line-ups typed in by the owner in the Content Studio, each with a cited source. */
  manualLineups?: RawSnapshot[];
  /** Generate the fictional development league (default true). */
  includeFixture?: boolean;
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
  // The fictional league is large; hosts that only serve real content can skip it.
  const withFixture = inputs.includeFixture !== false;
  const snaps = withFixture ? fixtureSnapshots(generateLeague(), at) : [];
  const kb = normalize(snaps);
  const conflicts = verify(kb);
  const today = inputs.today ?? new Date().toISOString().slice(0, 10);
  const fdKb = inputs.footballData?.length ? normalizeFootballData(inputs.footballData, today) : null;
  // Independent cross-check BEFORE generation, so disagreeing scores are quarantined by the TRUTH gate.
  const crossCheck =
    fdKb && inputs.openFootball?.length ? crossCheckOpenFootball(fdKb, inputs.openFootball) : null;
  const wdKb = inputs.wikidata?.length ? normalizeWikidata(inputs.wikidata) : null;
  let manualKb: ManualKB | null = null;
  const groups: CandidateGroup[] = [
    ...(withFixture
      ? [
          {
            kb,
            candidates: generateCandidates(kb),
            idPrefix: (i: number, f: string, kind: string) => `q_${kind}_${f.slice(0, 12)}_${i}`,
          },
        ]
      : []),
  ];
  // Provider question ids depend only on the fact fingerprint, so human reviews survive re-ingestion.
  if (fdKb)
    groups.push({
      kb: fdKb,
      candidates: generateFootballDataCandidates(fdKb, { today }),
      idPrefix: (_i, f) => `q_fd_${f.slice(0, 16)}`,
    });
  if (inputs.manualLineups?.length) {
    const mlKb = normalizeManualLineups(inputs.manualLineups);
    manualKb = mlKb;
    groups.push({ kb: mlKb, candidates: generateManualLineupCandidates(mlKb), idPrefix: manualIdPrefix });
  }
  if (wdKb)
    groups.push({
      kb: wdKb,
      candidates: generateWikidataCandidates(wdKb),
      idPrefix: (_i, f) => `q_wd_${f.slice(0, 16)}`,
    });
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const group of groups) questions.push(...gateCandidates(group, policy, at, seen));
  return { bank: new QuestionBank(questions), kb, conflicts, fdKb, wdKb, crossCheck, manualKb };
}

export interface CandidateGroup {
  kb: GateKB;
  candidates: Candidate[];
  idPrefix: (i: number, fp: string, kind: string) => string;
}

/** Runs every gate on a group of candidates and turns them into gated questions. */
export function gateCandidates(
  group: CandidateGroup,
  policy: PublishPolicy,
  at: string,
  seen: Set<string>,
): Question[] {
  const kb = group.kb;
  const out: Question[] = [];
  group.candidates.forEach((c, i) => {
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
    if (!failure && eligible && policy.autoApproveFixtures && (!highImpact || policy.autoApproveHighImpact)) {
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
    out.push({
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
  return out;
}
