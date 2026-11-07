import type { ContentItem, ContentKind, ModeKey } from '@ft/shared';

export type LicenseStatus = 'APPROVED' | 'PENDING' | 'DENIED';
export type SourceKind = 'SYNTHETIC_FIXTURE' | 'LICENSED_API' | 'OPEN_DATASET' | 'OFFICIAL_REFERENCE';

export interface SourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  licenseStatus: LicenseStatus;
  /** Uses the license explicitly grants. Gameplay display requires GAMEPLAY. */
  allowedUses: Array<'GAMEPLAY' | 'COMMERCIAL_REDISTRIBUTION' | 'RESEARCH_ONLY'>;
  attribution: string;
  termsUrl: string | null;
  /** True only for project-authored fictional fixtures. Never for real providers. */
  autoApproveEligible: boolean;
  integrated: boolean;
  notes: string;
}

export interface RawSnapshot {
  id: string;
  sourceId: string;
  retrievedAt: string;
  recordType: string;
  externalId: string;
  payload: unknown;
  /** sha256 of canonical JSON payload — immutable provenance */
  hash: string;
}

export type EntityType = 'PLAYER' | 'CLUB' | 'COMPETITION' | 'MATCH' | 'STADIUM';

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  names: Partial<Record<'en' | 'ar', string>>;
  aliases: string[];
  /** sourceId -> external id. Never merge two people only because names match. */
  sourceRefs: Record<string, string>;
}

export interface FactScope {
  competition: string;
  season: string | null;
  cutoff: string;
  statDefinition: string | null;
}

export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  value: string | number;
  scope: FactScope;
  sourceId: string;
  evidenceId: string;
  version: number;
  status: 'ACTIVE' | 'CONFLICTED' | 'SUPERSEDED';
}

export type QuestionStatus =
  | 'CANDIDATE'
  | 'NEEDS_EVIDENCE'
  | 'NEEDS_REVIEW'
  | 'QUARANTINED'
  | 'REJECTED'
  | 'DUPLICATE'
  | 'BLOCKED_RIGHTS'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'RETIRED';

export interface GateResult {
  gate: 'EVIDENCE' | 'IDENTITY' | 'TRUTH' | 'DISTRACTORS' | 'CLUES' | 'NOVELTY' | 'DIFFICULTY' | 'LICENSING' | 'MODE_VALIDATOR';
  passed: boolean;
  failureStatus: QuestionStatus | null;
  message: string;
}

export interface DifficultyInfo {
  /** 0–100 heuristic estimate (RECOMMENDED weights, not validated). */
  estimate: number;
  tier: 'EASY' | 'MEDIUM' | 'HARD' | 'EXPERT';
  status: 'PROVISIONAL' | 'CALIBRATED';
  components: Record<'rarity' | 'complexity' | 'distractorSimilarity' | 'temporalDistance' | 'recallDepth', number>;
  attempts: number;
  correct: number;
  posteriorMean: number | null;
}

export interface QuestionAuditEntry {
  at: string;
  actor: string;
  action: string;
  fromStatus: QuestionStatus | null;
  toStatus: QuestionStatus;
  note: string;
}

export interface Question {
  id: string;
  kind: ContentKind;
  modes: ModeKey[];
  version: number;
  status: QuestionStatus;
  template: string;
  item: ContentItem;
  factIds: string[];
  sourceIds: string[];
  /** canonical fact fingerprint + semantic fingerprint for dedupe */
  fingerprint: string;
  highImpact: boolean;
  gates: GateResult[];
  difficulty: DifficultyInfo;
  createdAt: string;
  audit: QuestionAuditEntry[];
}

export const KIND_TO_MODES: Record<ContentKind, ModeKey[]> = {
  mcq: ['last_man_standing', 'risk_it'],
  higher_lower: ['higher_lower'],
  short_answer: ['buzzer'],
  connection: ['connections'],
  timeline: ['timeline'],
  impostor: ['impostor'],
  missing_xi: ['missing_xi'],
  guess_match: ['guess_the_match'],
  top25: ['top25'],
  auction: ['auction'],
};

/** Blueprint B3: rankings and kickoff XIs need stronger (human) review. */
export const HIGH_IMPACT_KINDS: ContentKind[] = ['top25', 'missing_xi'];
