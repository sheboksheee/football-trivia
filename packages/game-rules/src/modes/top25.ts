import { GameError, matchesAlias, type AppealDecision, type Top25Item } from '@ft/shared';
import type { Engine } from '../types.js';
import type { Timing } from '../timing.js';
import { groupByScore } from '../ranking.js';

export const TOP25_TARGET = 100;
/** PROPOSED safety cap so a game cannot run forever if nobody reaches 100. */
export const TOP25_MAX_ROUNDS = 25;

interface Guess {
  player: string;
  round: number;
  text: string | null;
  at: number;
  /** matched rank, or null for wrong/timeout */
  rank: number | null;
  duplicate: boolean;
}
export interface Top25State {
  mode: 'top25';
  players: string[];
  timing: Timing;
  item: Top25Item;
  round: number;
  pos: number;
  guesses: Guess[];
  phase: 'TURN' | 'RESULT' | 'DONE';
  phaseStart: number;
  phaseEnd: number | null;
  voided: number[];
  /** guessIndex -> rank confirmed by judge on appeal */
  accepted: Record<string, number>;
  endReason: 'TARGET' | 'EXHAUSTED' | 'ROUND_CAP' | null;
}

/** Snake Draft: even rounds in seat order, odd rounds reversed. */
export function snakeOrder(players: string[], round: number): string[] {
  return round % 2 === 0 ? [...players] : [...players].reverse();
}

/** Who found each rank (first valid claim wins). Recomputed from the ledger so appeals stay consistent. */
export function claims(
  s: Pick<Top25State, 'guesses' | 'voided' | 'accepted'>,
): Map<number, { guessIndex: number; player: string }> {
  const out = new Map<number, { guessIndex: number; player: string }>();
  s.guesses.forEach((g, i) => {
    if (s.voided.includes(i)) return;
    const rank = s.accepted[String(i)] ?? g.rank;
    if (rank === null || out.has(rank)) return;
    out.set(rank, { guessIndex: i, player: g.player });
  });
  return out;
}

function scores(s: Top25State): Record<string, string> {
  const out: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (const [rank, c] of claims(s)) out[c.player] = (out[c.player] ?? 0) + rank;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)]));
}

function currentPlayer(s: Top25State): string {
  return snakeOrder(s.players, s.round)[s.pos]!;
}

function afterTurn(s: Top25State, at: number): Top25State {
  const found = claims(s).size;
  if (found >= s.item.entries.length)
    return { ...s, phase: 'DONE', phaseStart: at, phaseEnd: null, endReason: 'EXHAUSTED' };
  let { round, pos } = s;
  pos++;
  if (pos >= s.players.length) {
    // End of an equal-turn cycle: stop if anyone reached the target.
    const sc = scores(s);
    if (Object.values(sc).some((v) => Number(v) >= TOP25_TARGET))
      return { ...s, phase: 'DONE', phaseStart: at, phaseEnd: null, endReason: 'TARGET' };
    round++;
    pos = 0;
    if (round >= TOP25_MAX_ROUNDS)
      return { ...s, phase: 'DONE', phaseStart: at, phaseEnd: null, endReason: 'ROUND_CAP' };
  }
  return { ...s, round, pos, phase: 'TURN', phaseStart: at, phaseEnd: at + s.timing.top25Turn };
}

function record(s: Top25State, g: Omit<Guess, 'duplicate'>, at: number): Top25State {
  const taken = claims(s);
  const guess: Guess = { ...g, duplicate: g.rank !== null && taken.has(g.rank) };
  return {
    ...s,
    guesses: [...s.guesses, guess],
    phase: 'RESULT',
    phaseStart: at,
    phaseEnd: at + s.timing.top25Result,
  };
}

export function matchEntry(item: Top25Item, text: string): number | null {
  const e = item.entries.find((en) => matchesAlias(text, [en.label, ...en.aliases]));
  return e ? e.rank : null;
}

export const top25Engine: Engine<Top25State, Top25Item> = {
  key: 'top25',
  contentKind: 'top25',
  supportedDecisions: ['ACCEPT', 'REJECT', 'VOID'] as AppealDecision[],
  itemsNeeded: () => 1,
  init(ctx, items, now) {
    if (!items[0]) throw new Error('TOP 25 needs one list');
    return {
      mode: 'top25',
      players: [...ctx.players],
      timing: ctx.timing,
      item: items[0],
      round: 0,
      pos: 0,
      guesses: [],
      phase: 'TURN',
      phaseStart: now,
      phaseEnd: now + ctx.timing.top25Turn,
      voided: [],
      accepted: {},
      endReason: null,
    };
  },
  act(s, actor, action, now) {
    if (action.type !== 'guess') throw new GameError('INVALID_MESSAGE', 'Unknown action');
    if (s.phase !== 'TURN') throw new GameError('INVALID_STATE', 'Not guessing now');
    if (actor.role !== 'PLAYER' || actor.memberId !== currentPlayer(s))
      throw new GameError('FORBIDDEN', 'Not your turn');
    if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Time is up');
    const text = typeof action.text === 'string' ? action.text.trim() : '';
    if (!text || text.length > 80) throw new GameError('INVALID_MESSAGE', 'Guess must be 1–80 characters');
    return record(
      s,
      { player: actor.memberId, round: s.round, text, at: now, rank: matchEntry(s.item, text) },
      now,
    );
  },
  step(s, d) {
    if (s.phase === 'TURN')
      return record(s, { player: currentPlayer(s), round: s.round, text: null, at: d, rank: null }, d);
    if (s.phase === 'RESULT') return afterTurn(s, d);
    return s;
  },
  nextDeadline: (s) => (s.phase === 'DONE' ? null : s.phaseEnd),
  finished: (s) => s.phase === 'DONE',
  atBoundary: (s) => s.phase === 'RESULT',
  scores,
  // PROPOSED: equal totals share the place (TOP 25 tie rule is an open BLOCKER; no Sudden Draft).
  ranking: (s) => groupByScore(scores(s), s.players),
  appealWindows(s, now) {
    // Appeal windows run concurrently with play (15s after each guess result) so turns keep flowing.
    const out = [];
    for (let i = s.guesses.length - 1; i >= 0; i--) {
      const g = s.guesses[i]!;
      const closesAt = g.at + s.timing.appealWindow;
      if (closesAt <= now) break;
      if (g.text !== null && g.rank === null) out.push({ itemIndex: i, closesAt, eligible: [g.player] });
    }
    return out;
  },
  adjudicate(s, adj) {
    if (adj.decision === 'VOID')
      return s.voided.includes(adj.itemIndex) ? s : { ...s, voided: [...s.voided, adj.itemIndex] };
    if (adj.decision === 'ACCEPT') {
      const rank = adj.detail;
      if (rank === undefined || !s.item.entries.some((e) => e.rank === rank))
        throw new GameError('INVALID_MESSAGE', 'Accepting a TOP 25 appeal requires the matching rank');
      const holder = claims(s).get(rank);
      if (holder && holder.guessIndex < adj.itemIndex)
        throw new GameError('RULE_VIOLATION', `Rank ${rank} was already found earlier`);
      return { ...s, accepted: { ...s.accepted, [String(adj.itemIndex)]: rank } };
    }
    return s;
  },
  gradedBy: () => null,
  view(s, viewer) {
    const done = s.phase === 'DONE';
    const cl = claims(s);
    const last = s.guesses[s.guesses.length - 1];
    return {
      mode: 'top25',
      phase: s.phase,
      title: s.item.title,
      scope: s.item.scope,
      round: s.round,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      player: s.phase === 'DONE' ? null : currentPlayer(s),
      isMyTurn: s.phase === 'TURN' && viewer.memberId === currentPlayer(s),
      order: snakeOrder(s.players, s.round),
      target: TOP25_TARGET,
      // Hidden grid: only found entries (or all once finished) carry labels.
      grid: s.item.entries.map((e) => {
        const c = cl.get(e.rank);
        return {
          rank: e.rank,
          label: c || done ? e.label : null,
          metric: c || done ? e.metric : null,
          foundBy: c?.player ?? null,
        };
      }),
      lastGuess:
        last && s.phase !== 'TURN'
          ? { player: last.player, text: last.text, rank: last.rank, duplicate: last.duplicate }
          : null,
      endReason: s.endReason,
      scores: scores(s),
      attribution: s.item.meta.attribution,
    };
  },
};
