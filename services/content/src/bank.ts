import { shuffle, type ContentItem, type ContentKind } from '@ft/shared';
import { recordAttempts } from './difficulty.js';
import type { Question, QuestionStatus, DifficultyInfo } from './model.js';
import { sourceById } from './sources.js';

export type ReviewAction = 'APPROVE' | 'REJECT' | 'RETIRE' | 'QUARANTINE' | 'RESTORE';

/** Allowed review transitions. A review queue is not a loophole: failed gates cannot be approved. */
const TRANSITIONS: Record<ReviewAction, { from: QuestionStatus[]; to: QuestionStatus }> = {
  APPROVE: { from: ['NEEDS_REVIEW'], to: 'PUBLISHED' },
  REJECT: { from: ['NEEDS_REVIEW', 'PUBLISHED', 'QUARANTINED'], to: 'REJECTED' },
  RETIRE: { from: ['PUBLISHED'], to: 'RETIRED' },
  QUARANTINE: { from: ['PUBLISHED', 'NEEDS_REVIEW'], to: 'QUARANTINED' },
  RESTORE: { from: ['RETIRED'], to: 'NEEDS_REVIEW' },
};

/** Configurable playlist difficulty mix (Blueprint C2 starting policy). */
export const DEFAULT_MIX: Record<DifficultyInfo['tier'], number> = { EASY: 0.3, MEDIUM: 0.45, HARD: 0.2, EXPERT: 0.05 };

export class ReviewError extends Error {}

export class QuestionBank {
  private byId = new Map<string, Question>();
  constructor(questions: Question[] = []) {
    for (const q of questions) this.byId.set(q.id, q);
  }
  all(): Question[] {
    return [...this.byId.values()];
  }
  get(id: string): Question | undefined {
    return this.byId.get(id);
  }
  upsert(q: Question) {
    this.byId.set(q.id, q);
  }
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const q of this.byId.values()) {
      out[q.kind] ??= {};
      out[q.kind]![q.status] = (out[q.kind]![q.status] ?? 0) + 1;
    }
    return out;
  }

  review(id: string, action: ReviewAction, reviewerId: string, note: string, at = new Date().toISOString()): Question {
    const q = this.byId.get(id);
    if (!q) throw new ReviewError('Question not found');
    if (!note || note.trim().length < 3) throw new ReviewError('A review note is required');
    const t = TRANSITIONS[action];
    if (!t.from.includes(q.status)) throw new ReviewError(`Cannot ${action} a question in status ${q.status}`);
    if (action === 'APPROVE') {
      // Approval re-asserts the hard gates: every gate must pass except an explicit NEEDS_REVIEW flag.
      const hard = q.gates.filter((g) => !g.passed && g.failureStatus !== 'NEEDS_REVIEW');
      if (hard.length) throw new ReviewError(`Gates failed: ${hard.map((g) => g.gate).join(', ')}`);
      const rights = q.sourceIds.every((s) => sourceById(s)?.licenseStatus === 'APPROVED');
      if (!rights) throw new ReviewError('License not approved');
    }
    const next: Question = {
      ...q,
      status: t.to,
      version: action === 'APPROVE' || action === 'RESTORE' ? q.version : q.version,
      audit: [...q.audit, { at, actor: reviewerId, action: `review.${action.toLowerCase()}`, fromStatus: q.status, toStatus: t.to, note: note.trim() }],
    };
    this.byId.set(id, next);
    return next;
  }

  /** Records gameplay telemetry; calibration only reclassifies after the minimum sample. */
  recordResults(id: string, attempts: number, correct: number): Question | undefined {
    const q = this.byId.get(id);
    if (!q) return undefined;
    const next = { ...q, difficulty: recordAttempts(q.difficulty, attempts, correct) };
    this.byId.set(id, next);
    return next;
  }

  /**
   * Draws `count` PUBLISHED items of a kind, excluding ids already used in this room/session,
   * balancing difficulty toward `mix`. Deterministic for a given rng.
   */
  draw(kind: ContentKind, count: number, rng: () => number, exclude: Set<string> = new Set(), mix = DEFAULT_MIX): ContentItem[] {
    const pool = shuffle(
      this.all().filter((q) => q.kind === kind && q.status === 'PUBLISHED' && !exclude.has(q.id)),
      rng,
    );
    if (pool.length < count) throw new ReviewError(`Not enough published ${kind} questions (${pool.length}/${count})`);
    const byTier = new Map<string, Question[]>();
    for (const q of pool) byTier.set(q.difficulty.tier, [...(byTier.get(q.difficulty.tier) ?? []), q]);
    const picked: Question[] = [];
    const tiers = Object.entries(mix).sort((a, b) => b[1] - a[1]);
    for (const [tier, share] of tiers) {
      const want = Math.round(share * count);
      const avail = byTier.get(tier) ?? [];
      while (picked.length < count && avail.length && picked.filter((p) => p.difficulty.tier === tier).length < want) picked.push(avail.shift()!);
    }
    for (const q of pool) if (picked.length < count && !picked.includes(q)) picked.push(q);
    for (const q of picked) exclude.add(q.id);
    return shuffle(picked, rng).map((q) => q.item);
  }
}
