import { GameError, type AppealDecision, type TimelineItem } from '@ft/shared';
import type { Engine } from '../types.js';
import type { Timing } from '../timing.js';
import { groupByScore } from '../ranking.js';

export const TIMELINE_CHALLENGES_EACH = 2;

interface Duel {
  initiator: string;
  opponent: string;
  picks: Record<string, string>;
}
export interface TimelineState {
  mode: 'timeline';
  players: string[];
  timing: Timing;
  items: TimelineItem[];
  duels: Duel[];
  d: number;
  phase: 'INTRO' | 'ANSWER' | 'REVEAL' | 'DONE';
  phaseStart: number;
  phaseEnd: number | null;
  voided: number[];
  regraded: string[];
}

/**
 * PROPOSED balanced pairing: in challenge round r (0-based), the player in seat i challenges
 * seat (i + 1 + r) mod N, skipping themselves. Every player initiates exactly 2 and receives
 * exactly 2 challenges when N >= 3; with N = 2 both players face each other 4 times.
 */
export function timelinePairings(players: string[]): Array<[string, string]> {
  const n = players.length;
  const out: Array<[string, string]> = [];
  for (let r = 0; r < TIMELINE_CHALLENGES_EACH; r++) {
    for (let i = 0; i < n; i++) {
      let off = (1 + r) % n;
      if (off === 0) off = 1;
      out.push([players[i]!, players[(i + off) % n]!]);
    }
  }
  return out;
}

/** APPROVED: exactly one correct +3; both correct +1 each; both wrong 0. */
export function duelPoints(aCorrect: boolean, bCorrect: boolean): [number, number] {
  if (aCorrect && bCorrect) return [1, 1];
  if (aCorrect) return [3, 0];
  if (bCorrect) return [0, 3];
  return [0, 0];
}

function correctOf(s: TimelineState, i: number, m: string): boolean {
  if (s.regraded.includes(`${i}:${m}`)) return true;
  return s.duels[i]!.picks[m] === s.items[i]!.earlierId;
}

function settledUpTo(s: TimelineState) {
  return s.phase === 'DONE' ? s.duels.length : s.phase === 'REVEAL' ? s.d + 1 : s.d;
}

function scores(s: TimelineState): Record<string, string> {
  const out: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (let i = 0; i < settledUpTo(s); i++) {
    if (s.voided.includes(i)) continue;
    const { initiator: a, opponent: b } = s.duels[i]!;
    const [pa, pb] = duelPoints(correctOf(s, i, a), correctOf(s, i, b));
    out[a] = (out[a] ?? 0) + pa;
    out[b] = (out[b] ?? 0) + pb;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)]));
}

function begin(s: TimelineState, d: number, at: number): TimelineState {
  if (d >= s.duels.length)
    return { ...s, d: s.duels.length - 1, phase: 'DONE', phaseStart: at, phaseEnd: null };
  return { ...s, d, phase: 'INTRO', phaseStart: at, phaseEnd: at + s.timing.timelineIntro };
}

export const timelineEngine: Engine<TimelineState, TimelineItem> = {
  key: 'timeline',
  contentKind: 'timeline',
  supportedDecisions: ['ACCEPT', 'REJECT', 'VOID'] as AppealDecision[],
  itemsNeeded: (n) => n * TIMELINE_CHALLENGES_EACH,
  init(ctx, items, now) {
    const duels = timelinePairings(ctx.players).map(([initiator, opponent]) => ({
      initiator,
      opponent,
      picks: {},
    }));
    return begin(
      {
        mode: 'timeline',
        players: [...ctx.players],
        timing: ctx.timing,
        items: items.slice(0, duels.length),
        duels,
        d: 0,
        phase: 'INTRO',
        phaseStart: now,
        phaseEnd: null,
        voided: [],
        regraded: [],
      },
      0,
      now,
    );
  },
  act(s, actor, action, now) {
    if (action.type !== 'pick') throw new GameError('INVALID_MESSAGE', 'Unknown action');
    const duel = s.duels[s.d]!;
    if (actor.role !== 'PLAYER' || (actor.memberId !== duel.initiator && actor.memberId !== duel.opponent))
      throw new GameError('FORBIDDEN', 'You are not in this duel');
    if (s.phase !== 'ANSWER') throw new GameError('INVALID_STATE', 'Duel is not open');
    if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Time is up');
    if (duel.picks[actor.memberId]) throw new GameError('DUPLICATE', 'Already answered');
    const id = action.eventId;
    if (typeof id !== 'string' || !s.items[s.d]!.events.some((e) => e.id === id))
      throw new GameError('INVALID_MESSAGE', 'Unknown event');
    const duels = [...s.duels];
    duels[s.d] = { ...duel, picks: { ...duel.picks, [actor.memberId]: id } };
    const n = { ...s, duels };
    if (Object.keys(duels[s.d]!.picks).length === 2)
      return { ...n, phase: 'REVEAL', phaseStart: now, phaseEnd: now + s.timing.appealWindow };
    return n;
  },
  step(s, d) {
    if (s.phase === 'INTRO')
      return { ...s, phase: 'ANSWER', phaseStart: d, phaseEnd: d + s.timing.timelineAnswer };
    if (s.phase === 'ANSWER')
      return { ...s, phase: 'REVEAL', phaseStart: d, phaseEnd: d + s.timing.appealWindow };
    if (s.phase === 'REVEAL') return begin(s, s.d + 1, d);
    return s;
  },
  nextDeadline: (s) => (s.phase === 'DONE' ? null : s.phaseEnd),
  finished: (s) => s.phase === 'DONE',
  atBoundary: (s) => s.phase === 'REVEAL',
  scores,
  ranking: (s) => groupByScore(scores(s), s.players),
  appealWindows: (s, now) => {
    if (s.phase !== 'REVEAL' || s.phaseEnd === null || now >= s.phaseEnd) return [];
    const duel = s.duels[s.d]!;
    return [{ itemIndex: s.d, closesAt: s.phaseEnd, eligible: [duel.initiator, duel.opponent] }];
  },
  adjudicate(s, adj) {
    if (adj.decision === 'VOID' && !s.voided.includes(adj.itemIndex))
      return { ...s, voided: [...s.voided, adj.itemIndex] };
    const key = `${adj.itemIndex}:${adj.claimantId}`;
    if (adj.decision === 'ACCEPT' && !s.regraded.includes(key))
      return { ...s, regraded: [...s.regraded, key] };
    return s;
  },
  gradedBy: () => null,
  view(s, viewer) {
    const duel = s.duels[s.d]!;
    const item = s.items[s.d]!;
    const revealed = s.phase === 'REVEAL' || s.phase === 'DONE';
    const inDuel = viewer.memberId === duel.initiator || viewer.memberId === duel.opponent;
    return {
      mode: 'timeline',
      phase: s.phase,
      duelIndex: s.d,
      duelCount: s.duels.length,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      initiator: duel.initiator,
      opponent: duel.opponent,
      inDuel,
      item:
        s.phase === 'INTRO'
          ? null
          : {
              prompt: item.prompt,
              events: item.events.map((e) => ({ id: e.id, label: e.label, date: revealed ? e.date : null })),
              earlierId: revealed ? item.earlierId : null,
              attribution: revealed ? item.meta.attribution : null,
            },
      picks: Object.fromEntries(
        [duel.initiator, duel.opponent].map((m) => [
          m,
          revealed || viewer.memberId === m ? (duel.picks[m] ?? null) : duel.picks[m] ? 'HIDDEN' : null,
        ]),
      ),
      correct:
        revealed && !s.voided.includes(s.d)
          ? {
              [duel.initiator]: correctOf(s, s.d, duel.initiator),
              [duel.opponent]: correctOf(s, s.d, duel.opponent),
            }
          : null,
      voided: s.voided.includes(s.d),
      scores: scores(s),
    };
  },
};
