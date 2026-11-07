import { GameError, type AppealDecision, type McqItem } from '@ft/shared';
import type { Engine } from '../types.js';
import type { Timing } from '../timing.js';
import { groupByScore } from '../ranking.js';
import { viewMcq } from './lastManStanding.js';

export const RISK_TURNS_EACH = 6;
export const RISKS = { SAFE: [1, 0], BOLD: [3, -1], ALL_IN: [6, -3] } as const;
export type Risk = keyof typeof RISKS;

interface Turn {
  player: string;
  risk: Risk | null;
  riskDefaulted: boolean;
  optionId: string | null;
  answeredAt: number | null;
}
export interface RiskState {
  mode: 'risk_it';
  players: string[];
  timing: Timing;
  items: McqItem[];
  turns: Turn[];
  t: number;
  phase: 'CHOOSE' | 'ANSWER' | 'REVEAL' | 'DONE';
  phaseStart: number;
  phaseEnd: number | null;
  voided: number[];
  regraded: number[];
}

/** APPROVED values. Returns points for a settled turn; null risk never reaches here. */
export function riskPoints(risk: Risk, correct: boolean): number {
  return RISKS[risk][correct ? 0 : 1];
}

function correctOf(s: RiskState, i: number): boolean | null {
  if (s.voided.includes(i)) return null;
  if (s.regraded.includes(i)) return true;
  const turn = s.turns[i]!;
  return turn.optionId !== null && turn.optionId === s.items[i]!.correctOptionId;
}

function settledUpTo(s: RiskState): number {
  return s.phase === 'DONE' ? s.turns.length : s.phase === 'REVEAL' ? s.t + 1 : s.t;
}

function scores(s: RiskState): Record<string, string> {
  const out: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (let i = 0; i < settledUpTo(s); i++) {
    const turn = s.turns[i]!;
    const c = correctOf(s, i);
    if (c === null || turn.risk === null) continue;
    out[turn.player] = (out[turn.player] ?? 0) + riskPoints(turn.risk, c);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)]));
}

function begin(s: RiskState, t: number, at: number): RiskState {
  if (t >= s.turns.length) return { ...s, t: s.turns.length - 1, phase: 'DONE', phaseStart: at, phaseEnd: null };
  return { ...s, t, phase: 'CHOOSE', phaseStart: at, phaseEnd: at + s.timing.riskChoose };
}

function updateTurn(s: RiskState, patch: Partial<Turn>): RiskState {
  const turns = [...s.turns];
  turns[s.t] = { ...turns[s.t]!, ...patch };
  return { ...s, turns };
}

export const riskItEngine: Engine<RiskState, McqItem> = {
  key: 'risk_it',
  contentKind: 'mcq',
  supportedDecisions: ['ACCEPT', 'REJECT', 'VOID'] as AppealDecision[],
  itemsNeeded: (n) => n * RISK_TURNS_EACH,
  init(ctx, items, now) {
    const turns: Turn[] = [];
    for (let r = 0; r < RISK_TURNS_EACH; r++)
      for (const p of ctx.players) turns.push({ player: p, risk: null, riskDefaulted: false, optionId: null, answeredAt: null });
    const s: RiskState = {
      mode: 'risk_it',
      players: [...ctx.players],
      timing: ctx.timing,
      items: items.slice(0, turns.length),
      turns,
      t: 0,
      phase: 'CHOOSE',
      phaseStart: now,
      phaseEnd: null,
      voided: [],
      regraded: [],
    };
    return begin(s, 0, now);
  },
  act(s, actor, action, now) {
    const turn = s.turns[s.t]!;
    if (actor.role !== 'PLAYER' || actor.memberId !== turn.player) throw new GameError('FORBIDDEN', 'Not your turn');
    if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Time is up');
    if (action.type === 'risk') {
      if (s.phase !== 'CHOOSE') throw new GameError('INVALID_STATE', 'Risk already chosen');
      const risk = action.risk;
      if (risk !== 'SAFE' && risk !== 'BOLD' && risk !== 'ALL_IN') throw new GameError('INVALID_MESSAGE', 'Invalid risk');
      return { ...updateTurn(s, { risk }), phase: 'ANSWER', phaseStart: now, phaseEnd: now + s.timing.riskAnswer };
    }
    if (action.type === 'answer') {
      if (s.phase !== 'ANSWER') throw new GameError('INVALID_STATE', 'Not answering now');
      const id = action.optionId;
      if (typeof id !== 'string' || !s.items[s.t]!.options.some((o) => o.id === id)) throw new GameError('INVALID_MESSAGE', 'Unknown option');
      return { ...updateTurn(s, { optionId: id, answeredAt: now }), phase: 'REVEAL', phaseStart: now, phaseEnd: now + s.timing.appealWindow };
    }
    throw new GameError('INVALID_MESSAGE', 'Unknown action');
  },
  step(s, d) {
    if (s.phase === 'CHOOSE') {
      // PROPOSED: no risk chosen in time => SAFE.
      return { ...updateTurn(s, { risk: 'SAFE', riskDefaulted: true }), phase: 'ANSWER', phaseStart: d, phaseEnd: d + s.timing.riskAnswer };
    }
    if (s.phase === 'ANSWER') return { ...s, phase: 'REVEAL', phaseStart: d, phaseEnd: d + s.timing.appealWindow };
    if (s.phase === 'REVEAL') return begin(s, s.t + 1, d);
    return s;
  },
  nextDeadline: (s) => (s.phase === 'DONE' ? null : s.phaseEnd),
  finished: (s) => s.phase === 'DONE',
  atBoundary: (s) => s.phase === 'REVEAL',
  scores,
  ranking: (s) => groupByScore(scores(s), s.players),
  appealWindows: (s, now) =>
    s.phase === 'REVEAL' && s.phaseEnd !== null && now < s.phaseEnd
      ? [{ itemIndex: s.t, closesAt: s.phaseEnd, eligible: [s.turns[s.t]!.player] }]
      : [],
  adjudicate(s, adj) {
    if (adj.decision === 'VOID' && !s.voided.includes(adj.itemIndex)) return { ...s, voided: [...s.voided, adj.itemIndex] };
    if (adj.decision === 'ACCEPT' && !s.regraded.includes(adj.itemIndex)) return { ...s, regraded: [...s.regraded, adj.itemIndex] };
    return s;
  },
  gradedBy: () => null,
  view(s, viewer) {
    const turn = s.turns[s.t]!;
    const revealed = s.phase === 'REVEAL' || s.phase === 'DONE';
    const showQuestion = s.phase !== 'CHOOSE';
    return {
      mode: 'risk_it',
      phase: s.phase,
      turnIndex: s.t,
      turnCount: s.turns.length,
      turnsEach: RISK_TURNS_EACH,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      player: turn.player,
      isMyTurn: viewer.memberId === turn.player,
      risk: turn.risk,
      riskDefaulted: turn.riskDefaulted,
      item: showQuestion ? viewMcq(s.items[s.t]!, revealed) : null,
      answer: revealed ? turn.optionId : null,
      correct: revealed ? correctOf(s, s.t) : null,
      delta: revealed && turn.risk ? (correctOf(s, s.t) === null ? 0 : riskPoints(turn.risk, correctOf(s, s.t)!)) : null,
      scores: scores(s),
      history: s.turns.slice(0, settledUpTo(s)).map((tt, i) => ({ player: tt.player, risk: tt.risk, correct: correctOf(s, i) })),
    };
  },
};
