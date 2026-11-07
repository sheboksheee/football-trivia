import {
  createRng,
  GameError,
  matchesAlias,
  shuffle,
  type AppealDecision,
  type ImpostorItem,
} from '@ft/shared';
import type { Engine } from '../types.js';
import type { Timing } from '../timing.js';
import { groupByScore } from '../ranking.js';

type Phase = 'REVEAL' | 'CLUES' | 'DISCUSSION' | 'VOTE' | 'GUESS' | 'ROUND_REVEAL' | 'DONE';

interface Round {
  impostor: string;
  votes: Record<string, string>;
  guess: string | null;
}
export interface ImpostorState {
  mode: 'impostor';
  players: string[];
  timing: Timing;
  items: ImpostorItem[];
  rounds: Round[];
  r: number;
  phase: Phase;
  clueStep: number;
  phaseStart: number;
  phaseEnd: number | null;
  voided: number[];
  regraded: number[];
}

export const IMPOSTOR_CLUE_CYCLES = 2;
/** APPROVED: correct vote +2, escape +4, caught-and-guessed +3. */
export const IMPOSTOR_POINTS = { vote: 2, escape: 4, caughtGuessed: 3 } as const;

/** PROPOSED: caught only when the impostor has strictly the most votes. */
export function isCaught(votes: Record<string, string>, impostor: string): boolean {
  const tally: Record<string, number> = {};
  for (const v of Object.values(votes)) tally[v] = (tally[v] ?? 0) + 1;
  const imp = tally[impostor] ?? 0;
  if (imp === 0) return false;
  return Object.entries(tally).every(([m, c]) => m === impostor || c < imp);
}

function guessCorrect(s: ImpostorState, r: number): boolean {
  if (s.regraded.includes(r)) return true;
  const g = s.rounds[r]!.guess;
  const item = s.items[r]!;
  return g !== null && matchesAlias(g, [item.footballer, ...item.aliases]);
}

export function roundPoints(s: ImpostorState, r: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (s.voided.includes(r)) return out;
  const round = s.rounds[r]!;
  for (const [voter, target] of Object.entries(round.votes))
    if (voter !== round.impostor && target === round.impostor) out[voter] = IMPOSTOR_POINTS.vote;
  if (!isCaught(round.votes, round.impostor)) out[round.impostor] = IMPOSTOR_POINTS.escape;
  else if (guessCorrect(s, r)) out[round.impostor] = IMPOSTOR_POINTS.caughtGuessed;
  return out;
}

function settledUpTo(s: ImpostorState) {
  return s.phase === 'DONE' ? s.rounds.length : s.phase === 'ROUND_REVEAL' ? s.r + 1 : s.r;
}

function scores(s: ImpostorState): Record<string, string> {
  const out: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (let r = 0; r < settledUpTo(s); r++)
    for (const [m, p] of Object.entries(roundPoints(s, r))) out[m] = (out[m] ?? 0) + p;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)]));
}

function clueOrder(s: ImpostorState): string[] {
  const n = s.players.length;
  return Array.from({ length: n }, (_, k) => s.players[(k + s.r) % n]!);
}

function to(s: ImpostorState, phase: Phase, at: number, dur: number | null): ImpostorState {
  return { ...s, phase, phaseStart: at, phaseEnd: dur === null ? null : at + dur };
}

function startRound(s: ImpostorState, r: number, at: number): ImpostorState {
  if (r >= s.rounds.length) return { ...to(s, 'DONE', at, null), r: s.rounds.length - 1 };
  return { ...to(s, 'REVEAL', at, s.timing.impostorReveal), r, clueStep: 0 };
}

function afterVote(s: ImpostorState, at: number): ImpostorState {
  const round = s.rounds[s.r]!;
  return isCaught(round.votes, round.impostor)
    ? to(s, 'GUESS', at, s.timing.impostorGuess)
    : to(s, 'ROUND_REVEAL', at, s.timing.appealWindow);
}

export const impostorEngine: Engine<ImpostorState, ImpostorItem> = {
  key: 'impostor',
  contentKind: 'impostor',
  supportedDecisions: ['ACCEPT', 'REJECT', 'VOID'] as AppealDecision[],
  itemsNeeded: (n) => n,
  init(ctx, items, now) {
    if (ctx.players.length < 3) throw new GameError('INVALID_STATE', 'The Impostor needs at least 3 players');
    const order = shuffle(ctx.players, createRng(ctx.seed));
    const rounds = order.map((impostor) => ({ impostor, votes: {}, guess: null }));
    const s: ImpostorState = {
      mode: 'impostor',
      players: [...ctx.players],
      timing: ctx.timing,
      items: items.slice(0, rounds.length),
      rounds,
      r: 0,
      phase: 'REVEAL',
      clueStep: 0,
      phaseStart: now,
      phaseEnd: null,
      voided: [],
      regraded: [],
    };
    return startRound(s, 0, now);
  },
  act(s, actor, action, now) {
    if (actor.role !== 'PLAYER' || !s.players.includes(actor.memberId))
      throw new GameError('FORBIDDEN', 'Only players can act');
    if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Time is up');
    const round = s.rounds[s.r]!;
    if (action.type === 'vote') {
      if (s.phase !== 'VOTE') throw new GameError('INVALID_STATE', 'Voting is not open');
      const target = action.target;
      if (typeof target !== 'string' || !s.players.includes(target))
        throw new GameError('INVALID_MESSAGE', 'Unknown player');
      if (target === actor.memberId) throw new GameError('RULE_VIOLATION', 'You cannot vote for yourself');
      if (round.votes[actor.memberId]) throw new GameError('DUPLICATE', 'Vote already cast');
      const rounds = [...s.rounds];
      rounds[s.r] = { ...round, votes: { ...round.votes, [actor.memberId]: target } };
      const n = { ...s, rounds };
      return Object.keys(rounds[s.r]!.votes).length === s.players.length ? afterVote(n, now) : n;
    }
    if (action.type === 'guess') {
      if (s.phase !== 'GUESS') throw new GameError('INVALID_STATE', 'No guess expected');
      if (actor.memberId !== round.impostor)
        throw new GameError('FORBIDDEN', 'Only the caught impostor guesses');
      const text = typeof action.text === 'string' ? action.text.trim() : '';
      if (!text || text.length > 80) throw new GameError('INVALID_MESSAGE', 'Guess must be 1–80 characters');
      const rounds = [...s.rounds];
      rounds[s.r] = { ...round, guess: text };
      return to({ ...s, rounds }, 'ROUND_REVEAL', now, s.timing.appealWindow);
    }
    if (action.type === 'clueDone') {
      // The current clue-giver may finish early.
      if (s.phase !== 'CLUES' || clueOrder(s)[s.clueStep % s.players.length] !== actor.memberId)
        throw new GameError('INVALID_STATE', 'Not your clue turn');
      return impostorEngine.step(s, now);
    }
    throw new GameError('INVALID_MESSAGE', 'Unknown action');
  },
  step(s, d) {
    switch (s.phase) {
      case 'REVEAL':
        return { ...to(s, 'CLUES', d, s.timing.impostorClue), clueStep: 0 };
      case 'CLUES': {
        const next = s.clueStep + 1;
        if (next >= s.players.length * IMPOSTOR_CLUE_CYCLES)
          return to(s, 'DISCUSSION', d, s.timing.impostorDiscussion);
        return { ...to(s, 'CLUES', d, s.timing.impostorClue), clueStep: next };
      }
      case 'DISCUSSION':
        return to(s, 'VOTE', d, s.timing.impostorVote);
      case 'VOTE':
        return afterVote(s, d);
      case 'GUESS':
        return to(s, 'ROUND_REVEAL', d, s.timing.appealWindow);
      case 'ROUND_REVEAL':
        return startRound(s, s.r + 1, d);
      default:
        return s;
    }
  },
  nextDeadline: (s) => (s.phase === 'DONE' ? null : s.phaseEnd),
  finished: (s) => s.phase === 'DONE',
  atBoundary: (s) => s.phase === 'ROUND_REVEAL',
  scores,
  ranking: (s) => groupByScore(scores(s), s.players),
  appealWindows(s, now) {
    if (s.phase !== 'ROUND_REVEAL' || s.phaseEnd === null || now >= s.phaseEnd) return [];
    return [{ itemIndex: s.r, closesAt: s.phaseEnd, eligible: [...s.players] }];
  },
  adjudicate(s, adj) {
    if (adj.decision === 'VOID' && !s.voided.includes(adj.itemIndex))
      return { ...s, voided: [...s.voided, adj.itemIndex] };
    if (adj.decision === 'ACCEPT') {
      const round = s.rounds[adj.itemIndex]!;
      if (adj.claimantId !== round.impostor || round.guess === null)
        throw new GameError('RULE_VIOLATION', 'Only the impostor’s guess can be accepted');
      if (!s.regraded.includes(adj.itemIndex)) return { ...s, regraded: [...s.regraded, adj.itemIndex] };
    }
    return s;
  },
  gradedBy: () => null,
  view(s, viewer) {
    const round = s.rounds[s.r]!;
    const item = s.items[s.r]!;
    const roundOver = s.phase === 'ROUND_REVEAL' || s.phase === 'DONE';
    const me = viewer.memberId;
    const isPlayer = viewer.role === 'PLAYER' && me !== null && s.players.includes(me);
    const amImpostor = isPlayer && me === round.impostor;
    const caught = s.phase === 'GUESS' || roundOver ? isCaught(round.votes, round.impostor) : null;
    const order = clueOrder(s);
    return {
      mode: 'impostor',
      phase: s.phase,
      round: s.r,
      roundCount: s.rounds.length,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      // Secret delivery: only non-impostor players see the footballer while the round is live.
      role: isPlayer ? (amImpostor ? 'IMPOSTOR' : 'CREW') : null,
      footballer: roundOver || (isPlayer && !amImpostor) ? item.footballer : null,
      context: roundOver || (isPlayer && !amImpostor) ? item.context : null,
      clueGiver: s.phase === 'CLUES' ? order[s.clueStep % s.players.length] : null,
      clueCycle: s.phase === 'CLUES' ? Math.floor(s.clueStep / s.players.length) + 1 : null,
      clueOrder: order,
      // Votes stay private until the round reveal; others only see who has voted.
      myVote: me ? (round.votes[me] ?? null) : null,
      voted: Object.keys(round.votes),
      votes: roundOver ? round.votes : null,
      impostor: caught !== null && (caught || roundOver) ? round.impostor : null,
      caught,
      guess: roundOver ? round.guess : null,
      guessCorrect: roundOver && caught ? guessCorrect(s, s.r) : null,
      roundPoints: roundOver ? roundPoints(s, s.r) : null,
      voided: s.voided.includes(s.r),
      attribution: roundOver ? item.meta.attribution : null,
      scores: scores(s),
    };
  },
};
