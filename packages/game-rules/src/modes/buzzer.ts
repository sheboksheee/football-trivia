import { GameError, type AppealDecision, type ShortAnswerItem } from '@ft/shared';
import type { Engine } from '../types.js';
import type { Timing } from '../timing.js';
import { groupByScore } from '../ranking.js';

export const BUZZER_QUESTIONS = 10;
export type Verdict = 'CORRECT' | 'WRONG' | 'TIMEOUT' | 'VOID';

interface Buzz {
  player: string;
  at: number;
  verdict: Verdict | null;
  judge: string | null;
}
interface Q {
  buzzes: Buzz[];
  /** all buzz presses received, in server order, for audit (including rejected late presses) */
  presses: Array<{ player: string; at: number; accepted: boolean }>;
}
export interface BuzzerState {
  mode: 'buzzer';
  players: string[];
  judges: string[];
  timing: Timing;
  items: ShortAnswerItem[];
  q: Q[];
  i: number;
  phase: 'OPEN' | 'ANSWERING' | 'REVEAL' | 'DONE';
  phaseStart: number;
  phaseEnd: number | null;
  voided: number[];
  regraded: string[];
}

/** APPROVED: correct +3, wrong/timeout −1. A voided buzz scores 0. */
export function buzzPoints(v: Verdict | null): number {
  return v === 'CORRECT' ? 3 : v === 'WRONG' || v === 'TIMEOUT' ? -1 : 0;
}

function settledUpTo(s: BuzzerState) {
  return s.phase === 'DONE' ? s.items.length : s.phase === 'REVEAL' ? s.i + 1 : s.i;
}

function scores(s: BuzzerState): Record<string, string> {
  const out: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (let i = 0; i < settledUpTo(s); i++) {
    if (s.voided.includes(i)) continue;
    for (const b of s.q[i]!.buzzes) {
      const v = s.regraded.includes(`${i}:${b.player}`) ? 'CORRECT' : b.verdict;
      out[b.player] = (out[b.player] ?? 0) + buzzPoints(v);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)]));
}

function lockedOut(s: BuzzerState): string[] {
  return s.q[s.i]!.buzzes.map((b) => b.player);
}

function open(s: BuzzerState, i: number, at: number): BuzzerState {
  if (i >= s.items.length) return { ...s, i: s.items.length - 1, phase: 'DONE', phaseStart: at, phaseEnd: null };
  const q = [...s.q];
  if (!q[i]) q[i] = { buzzes: [], presses: [] };
  return { ...s, q, i, phase: 'OPEN', phaseStart: at, phaseEnd: at + s.timing.buzzerOpen };
}

function reveal(s: BuzzerState, at: number): BuzzerState {
  return { ...s, phase: 'REVEAL', phaseStart: at, phaseEnd: at + s.timing.appealWindow };
}

function setVerdict(s: BuzzerState, v: Verdict, judge: string | null, at: number): BuzzerState {
  const q = [...s.q];
  const cur = { ...q[s.i]!, buzzes: [...q[s.i]!.buzzes] };
  const last = cur.buzzes.length - 1;
  cur.buzzes[last] = { ...cur.buzzes[last]!, verdict: v, judge };
  q[s.i] = cur;
  const n = { ...s, q };
  if (v === 'CORRECT' || v === 'VOID') return reveal(n, at);
  // Wrong/timeout: reopen for players who have not yet buzzed on this question (once each).
  const remaining = s.players.filter((p) => !cur.buzzes.some((b) => b.player === p));
  return remaining.length > 0 ? { ...n, phase: 'OPEN', phaseStart: at, phaseEnd: at + s.timing.buzzerOpen } : reveal(n, at);
}

export const buzzerEngine: Engine<BuzzerState, ShortAnswerItem> = {
  key: 'buzzer',
  contentKind: 'short_answer',
  supportedDecisions: ['ACCEPT', 'REJECT', 'VOID'] as AppealDecision[],
  itemsNeeded: () => BUZZER_QUESTIONS,
  init(ctx, items, now) {
    if (ctx.judges.length === 0) throw new GameError('INVALID_STATE', 'Buzzer Battle requires a neutral judge');
    return open({ mode: 'buzzer', players: [...ctx.players], judges: [...ctx.judges], timing: ctx.timing, items, q: [], i: 0, phase: 'OPEN', phaseStart: now, phaseEnd: null, voided: [], regraded: [] }, 0, now);
  },
  act(s, actor, action, now) {
    if (s.phaseEnd !== null && now >= s.phaseEnd && s.phase !== 'ANSWERING') throw new GameError('DEADLINE_PASSED', 'Time is up');
    if (action.type === 'buzz') {
      if (actor.role !== 'PLAYER' || !s.players.includes(actor.memberId)) throw new GameError('FORBIDDEN', 'Only players can buzz');
      const q = [...s.q];
      const cur = { ...q[s.i]!, presses: [...q[s.i]!.presses] };
      const accepted = s.phase === 'OPEN' && !lockedOut(s).includes(actor.memberId);
      cur.presses.push({ player: actor.memberId, at: now, accepted });
      q[s.i] = cur;
      if (!accepted) {
        // Server receipt order is authoritative; a press after the floor is taken is recorded but not accepted.
        throw new GameError(s.phase === 'OPEN' ? 'RULE_VIOLATION' : 'INVALID_STATE', s.phase === 'OPEN' ? 'Already used your buzz' : 'Buzzer is closed');
      }
      cur.buzzes = [...cur.buzzes, { player: actor.memberId, at: now, verdict: null, judge: null }];
      return { ...s, q, phase: 'ANSWERING', phaseStart: now, phaseEnd: now + s.timing.buzzerAnswer + s.timing.buzzerJudgeGrace };
    }
    if (action.type === 'verdict') {
      if (actor.role !== 'JUDGE' || !s.judges.includes(actor.memberId)) throw new GameError('FORBIDDEN', 'Only the judge can rule');
      if (s.phase !== 'ANSWERING') throw new GameError('INVALID_STATE', 'Nobody is answering');
      if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Judging window closed');
      const v = action.verdict;
      if (v !== 'CORRECT' && v !== 'WRONG' && v !== 'TIMEOUT') throw new GameError('INVALID_MESSAGE', 'Invalid verdict');
      const buzz = s.q[s.i]!.buzzes[s.q[s.i]!.buzzes.length - 1]!;
      if (v === 'TIMEOUT' && now < buzz.at + s.timing.buzzerAnswer) throw new GameError('RULE_VIOLATION', 'The 8s answer window has not expired');
      return setVerdict(s, v, actor.memberId, now);
    }
    throw new GameError('INVALID_MESSAGE', 'Unknown action');
  },
  step(s, d) {
    if (s.phase === 'OPEN') return reveal(s, d); // nobody (else) buzzed
    if (s.phase === 'ANSWERING') {
      // PROPOSED: no judge verdict in time => the buzz is void and the question ends.
      return setVerdict(s, 'VOID', null, d);
    }
    if (s.phase === 'REVEAL') return open(s, s.i + 1, d);
    return s;
  },
  nextDeadline: (s) => (s.phase === 'DONE' ? null : s.phaseEnd),
  finished: (s) => s.phase === 'DONE',
  atBoundary: (s) => s.phase === 'REVEAL',
  scores,
  ranking: (s) => groupByScore(scores(s), s.players),
  appealWindows(s, now) {
    if (s.phase !== 'REVEAL' || s.phaseEnd === null || now >= s.phaseEnd) return [];
    const eligible = s.q[s.i]!.buzzes.filter((b) => b.verdict === 'WRONG' || b.verdict === 'TIMEOUT').map((b) => b.player);
    return eligible.length ? [{ itemIndex: s.i, closesAt: s.phaseEnd, eligible }] : [];
  },
  adjudicate(s, adj) {
    if (adj.decision === 'VOID' && !s.voided.includes(adj.itemIndex)) return { ...s, voided: [...s.voided, adj.itemIndex] };
    const key = `${adj.itemIndex}:${adj.claimantId}`;
    if (adj.decision === 'ACCEPT' && !s.regraded.includes(key)) return { ...s, regraded: [...s.regraded, key] };
    return s;
  },
  gradedBy: (s, i, m) => s.q[i]?.buzzes.find((b) => b.player === m)?.judge ?? null,
  view(s, viewer) {
    const item = s.items[s.i]!;
    const q = s.q[s.i]!;
    const revealed = s.phase === 'REVEAL' || s.phase === 'DONE';
    const isJudge = viewer.role === 'JUDGE' && viewer.memberId !== null && s.judges.includes(viewer.memberId);
    const current = s.phase === 'ANSWERING' ? q.buzzes[q.buzzes.length - 1]! : null;
    return {
      mode: 'buzzer',
      phase: s.phase,
      itemIndex: s.i,
      itemCount: s.items.length,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      answerWindowEnd: current ? current.at + s.timing.buzzerAnswer : null,
      prompt: item.prompt,
      // Judge needs the key to rule on spoken answers; nobody else sees it before reveal.
      answer: revealed || isJudge ? item.answer : null,
      aliases: isJudge ? item.aliases : null,
      explanation: revealed ? item.explanation : null,
      attribution: revealed ? item.meta.attribution : null,
      onFloor: current?.player ?? null,
      lockedOut: q.buzzes.map((b) => b.player),
      buzzes: q.buzzes.map((b) => ({ player: b.player, verdict: b.verdict })),
      canBuzz: s.phase === 'OPEN' && viewer.role === 'PLAYER' && !!viewer.memberId && s.players.includes(viewer.memberId) && !q.buzzes.some((b) => b.player === viewer.memberId),
      voided: s.voided.includes(s.i),
      scores: scores(s),
    };
  },
};
