import { GameError, type AppealDecision, type ContentItem, type ContentKind } from '@ft/shared';
import type { Actor, Adjudication, AppealWindow, Engine, EngineCtx, Viewer } from './types.js';
import type { Timing } from './timing.js';
import { groupByScore } from './ranking.js';

/**
 * Shared machinery for modes where all eligible players answer the same item at the same time:
 * QUESTION (timed) -> [REVIEW (judge, optional)] -> REVEAL (15s appeal window) -> next item.
 */
export interface SimAnswer {
  at: number;
  [k: string]: unknown;
}

export interface SimState<I extends ContentItem = ContentItem, A extends SimAnswer = SimAnswer, X = unknown> {
  mode: string;
  players: string[];
  judges: string[];
  timing: Timing;
  items: I[];
  index: number;
  phase: 'QUESTION' | 'REVIEW' | 'REVEAL' | 'DONE';
  phaseStart: number;
  phaseEnd: number | null;
  answers: Record<string, A>[];
  /** Per-item outcome: null = void for everyone. */
  voided: number[];
  regraded: string[];
  /** Pending judge reviews: `${itemIndex}:${memberId}` */
  reviews: string[];
  reviewedBy: Record<string, string>;
  eligibleByItem: string[][];
  /** Game-time of the last processed step (milestones before this are consumed). */
  lastStep: number;
  extra: X;
}

export interface SimSpec<I extends ContentItem, A extends SimAnswer, X> {
  key: string;
  contentKind: ContentKind;
  itemsNeeded(playerCount: number): number;
  questionMs(t: Timing): number;
  initExtra(ctx: EngineCtx): X;
  /** Who answers item i (defaults to all players). */
  eligible?(s: SimState<I, A, X>): string[];
  parseAnswer(
    s: SimState<I, A, X>,
    item: I,
    memberId: string,
    action: Record<string, unknown>,
    now: number,
  ): A;
  /** Auto-grade. Return 'review' to send to the judge (only used when a judge exists). */
  grade(item: I, ans: A | undefined): boolean | 'review';
  /** Optional non-answer actions during QUESTION (e.g. view hint). */
  extraAction?(
    s: SimState<I, A, X>,
    memberId: string,
    action: Record<string, unknown>,
    now: number,
  ): SimState<I, A, X>;
  /** Called when an item's REVEAL ends (after adjudications) — e.g. hearts. */
  onItemSettled?(s: SimState<I, A, X>, correct: (i: number, m: string) => boolean | null): SimState<I, A, X>;
  /** Extra absolute game-times during QUESTION when the public view changes (e.g. clue reveals). */
  milestones?(s: SimState<I, A, X>): number[];
  shouldEnd?(s: SimState<I, A, X>): boolean;
  scores(s: SimState<I, A, X>, correct: (i: number, m: string) => boolean | null): Record<string, string>;
  ranking?(s: SimState<I, A, X>, scores: Record<string, string>): string[][];
  viewItem(s: SimState<I, A, X>, item: I, revealed: boolean, viewer: Viewer, now: number): unknown;
  viewAnswer(ans: A, item: I): unknown;
  /** Close the question early when all eligible players have answered (default true). */
  earlyClose?: boolean;
  supportedDecisions?: AppealDecision[];
}

export type AnySimState = SimState<ContentItem, SimAnswer, unknown>;

export function makeSimultaneousEngine<I extends ContentItem, A extends SimAnswer, X>(
  spec: SimSpec<I, A, X>,
): Engine<SimState<I, A, X>, I> {
  type S = SimState<I, A, X>;

  const correctFn =
    (s: S) =>
    (i: number, m: string): boolean | null => {
      if (s.voided.includes(i)) return null;
      if (s.regraded.includes(`${i}:${m}`)) return true;
      const key = `${i}:${m}`;
      if (s.reviewedBy[key] !== undefined) {
        // reviewed answers are stored on the answer itself
        return (s.answers[i]?.[m] as unknown as { reviewVerdict?: boolean })?.reviewVerdict === true;
      }
      const g = spec.grade(s.items[i]!, s.answers[i]?.[m]);
      return g === true;
    };

  /** Correctness only for items whose result is public (prevents leaking via live scores). */
  const revealedCorrect = (s: S) => {
    const c = correctFn(s);
    return (i: number, m: string): boolean | null => {
      if (i > s.index) return null;
      if (i === s.index && (s.phase === 'QUESTION' || s.phase === 'REVIEW')) return null;
      return c(i, m);
    };
  };

  const eligibleNow = (s: S) => (spec.eligible ? spec.eligible(s) : s.players);

  function startItem(s: S, index: number, at: number): S {
    if (index >= s.items.length)
      return { ...s, phase: 'DONE', phaseStart: at, phaseEnd: null, index: s.items.length };
    const next: S = {
      ...s,
      index,
      phase: 'QUESTION',
      phaseStart: at,
      phaseEnd: at + spec.questionMs(s.timing),
    };
    const elig = eligibleNow(next);
    const eligibleByItem = [...s.eligibleByItem];
    eligibleByItem[index] = elig;
    const answers = [...s.answers];
    answers[index] = {};
    return { ...next, eligibleByItem, answers };
  }

  function closeQuestion(s: S, at: number): S {
    const i = s.index;
    const item = s.items[i]!;
    const reviews: string[] = [];
    if (s.judges.length > 0) {
      for (const [m, a] of Object.entries(s.answers[i] ?? {})) {
        if (spec.grade(item, a) === 'review') reviews.push(`${i}:${m}`);
      }
    }
    if (reviews.length > 0) return { ...s, phase: 'REVIEW', phaseStart: at, phaseEnd: null, reviews };
    return { ...s, phase: 'REVEAL', phaseStart: at, phaseEnd: at + s.timing.appealWindow, reviews: [] };
  }

  function settle(s: S, at: number): S {
    let n = spec.onItemSettled ? spec.onItemSettled(s, correctFn(s)) : s;
    if (spec.shouldEnd?.(n)) return { ...n, phase: 'DONE', phaseStart: at, phaseEnd: null };
    n = startItem(n, n.index + 1, at);
    return n;
  }

  const engine: Engine<S, I> = {
    key: spec.key,
    contentKind: spec.contentKind,
    itemsNeeded: spec.itemsNeeded,
    supportedDecisions: spec.supportedDecisions ?? ['ACCEPT', 'REJECT', 'VOID'],
    init(ctx, items, now) {
      const base: S = {
        mode: spec.key,
        players: [...ctx.players],
        judges: [...ctx.judges],
        timing: ctx.timing,
        items,
        index: -1,
        phase: 'QUESTION',
        phaseStart: now,
        phaseEnd: null,
        answers: [],
        voided: [],
        regraded: [],
        reviews: [],
        reviewedBy: {},
        eligibleByItem: [],
        lastStep: now,
        extra: spec.initExtra(ctx),
      };
      return startItem(base, 0, now);
    },
    act(s, actor: Actor, action, now) {
      const type = action.type;
      if (type === 'review') {
        if (actor.role !== 'JUDGE' || !s.judges.includes(actor.memberId))
          throw new GameError('FORBIDDEN', 'Only a judge can review');
        if (s.phase !== 'REVIEW') throw new GameError('INVALID_STATE', 'Nothing to review');
        const memberId = String(action.memberId ?? '');
        const key = `${s.index}:${memberId}`;
        if (!s.reviews.includes(key)) throw new GameError('NOT_FOUND', 'No pending review for that player');
        if (memberId === actor.memberId)
          throw new GameError('CONFLICT_OF_INTEREST', 'Cannot review own answer');
        if (typeof action.accept !== 'boolean')
          throw new GameError('INVALID_MESSAGE', 'accept must be boolean');
        const ans = { ...(s.answers[s.index]![memberId] as A), reviewVerdict: action.accept };
        const answers = [...s.answers];
        answers[s.index] = { ...answers[s.index], [memberId]: ans };
        const reviews = s.reviews.filter((r) => r !== key);
        let n: S = { ...s, answers, reviews, reviewedBy: { ...s.reviewedBy, [key]: actor.memberId } };
        if (reviews.length === 0)
          n = { ...n, phase: 'REVEAL', phaseStart: now, phaseEnd: now + s.timing.appealWindow };
        return n;
      }
      if (actor.role !== 'PLAYER') throw new GameError('FORBIDDEN', 'Only players can answer');
      if (s.phase !== 'QUESTION') throw new GameError('INVALID_STATE', 'No question is open');
      if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Time is up');
      const elig = s.eligibleByItem[s.index] ?? [];
      if (!elig.includes(actor.memberId))
        throw new GameError('FORBIDDEN', 'You are not answering this question');
      if (typeof action.itemIndex === 'number' && action.itemIndex !== s.index)
        throw new GameError('STALE_VERSION', 'Answer is for a different question');
      if (type !== 'answer') {
        if (!spec.extraAction) throw new GameError('INVALID_MESSAGE', `Unknown action ${String(type)}`);
        return spec.extraAction(s, actor.memberId, action, now);
      }
      if (s.answers[s.index]?.[actor.memberId]) throw new GameError('DUPLICATE', 'Answer already locked in');
      const item = s.items[s.index]!;
      const ans = spec.parseAnswer(s, item, actor.memberId, action, now);
      const answers = [...s.answers];
      answers[s.index] = { ...answers[s.index], [actor.memberId]: ans };
      let n: S = { ...s, answers };
      if ((spec.earlyClose ?? true) && elig.every((m) => answers[s.index]![m])) n = closeQuestion(n, now);
      return n;
    },
    step(s, deadline) {
      const t = { ...s, lastStep: deadline };
      if (s.phaseEnd !== null && deadline < s.phaseEnd) return t; // milestone only
      if (s.phase === 'QUESTION') return closeQuestion(t, deadline);
      if (s.phase === 'REVEAL') return settle(t, deadline);
      return t;
    },
    nextDeadline(s) {
      if (s.phase === 'DONE' || s.phase === 'REVIEW') return null;
      let d = s.phaseEnd;
      if (s.phase === 'QUESTION' && spec.milestones) {
        for (const m of spec.milestones(s)) if (m > s.lastStep && (d === null || m < d)) d = m;
      }
      return d;
    },
    finished: (s) => s.phase === 'DONE',
    atBoundary: (s) => s.phase === 'REVEAL',
    scores: (s) => spec.scores(s, revealedCorrect(s)),
    ranking(s) {
      const sc = spec.scores(s, revealedCorrect(s));
      return spec.ranking ? spec.ranking(s, sc) : groupByScore(sc, s.players);
    },
    appealWindows(s, now) {
      if (s.phase !== 'REVEAL' || s.phaseEnd === null || now >= s.phaseEnd) return [];
      return [
        {
          itemIndex: s.index,
          closesAt: s.phaseEnd,
          eligible: s.eligibleByItem[s.index] ?? [],
        } satisfies AppealWindow,
      ];
    },
    adjudicate(s, adj: Adjudication) {
      if (adj.decision === 'REJECT') return s;
      if (adj.decision === 'VOID')
        return s.voided.includes(adj.itemIndex) ? s : { ...s, voided: [...s.voided, adj.itemIndex] };
      const key = `${adj.itemIndex}:${adj.claimantId}`;
      return s.regraded.includes(key) ? s : { ...s, regraded: [...s.regraded, key] };
    },
    gradedBy: (s, i, m) => s.reviewedBy[`${i}:${m}`] ?? null,
    view(s, viewer, now) {
      const i = Math.min(s.index, s.items.length - 1);
      const item = s.items[i];
      const revealed = s.phase === 'REVEAL' || s.phase === 'DONE';
      const correct = revealedCorrect(s);
      const sc = spec.scores(s, correct);
      const answers = s.answers[i] ?? {};
      const isJudge =
        viewer.role === 'JUDGE' && viewer.memberId !== null && s.judges.includes(viewer.memberId);
      return {
        mode: s.mode,
        phase: s.phase,
        itemIndex: i,
        itemCount: s.items.length,
        phaseStart: s.phaseStart,
        phaseEnd: s.phaseEnd,
        eligible: s.eligibleByItem[i] ?? [],
        item: item ? spec.viewItem(s, item, revealed, viewer, now) : null,
        scores: sc,
        // Before reveal: only "has answered" flags (and the viewer's own answer).
        submissions: Object.fromEntries(
          (s.eligibleByItem[i] ?? []).map((m) => {
            const a = answers[m];
            const own = viewer.memberId === m;
            if (!a) return [m, { answered: false }];
            if (!revealed && !own) return [m, { answered: true }];
            return [
              m,
              {
                answered: true,
                answer: spec.viewAnswer(a, item!),
                correct: revealed ? correct(i, m) : undefined,
              },
            ];
          }),
        ),
        voided: s.voided.includes(i),
        // Judges see pending reviews (answer text + canonical link) only while reviewing.
        reviews:
          isJudge && s.phase === 'REVIEW'
            ? s.reviews.map((r) => {
                const m = r.split(':')[1]!;
                return { memberId: m, answer: spec.viewAnswer(answers[m]!, item!) };
              })
            : [],
        reviewKey: isJudge && s.phase === 'REVIEW' && item ? spec.viewItem(s, item, true, viewer, now) : null,
        extra: modePublicExtra(s),
      };
    },
  };
  return engine;
}

function modePublicExtra(s: { extra: unknown }): unknown {
  const e = s.extra as { public?: unknown } | null;
  return e && typeof e === 'object' && 'public' in e ? e.public : null;
}
