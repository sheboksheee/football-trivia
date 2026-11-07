import { GameError, type AppealDecision, type AuctionItem } from '@ft/shared';
import type { Engine } from '../types.js';
import type { Timing } from '../timing.js';
import { groupByScore } from '../ranking.js';

/** APPROVED: success bidder +5; failure bidder −2 and challenger +5. */
export const AUCTION_POINTS = { success: 5, failBidder: -2, failChallenger: 5 } as const;

interface Round {
  opener: string;
  bid: number;
  bidder: string | null;
  active: string[];
  lastDropper: string | null;
  turn: string;
  bids: Array<{ player: string; amount: number | 'DROP'; at: number; auto: boolean }>;
  /** judge counter ledger: +1 valid tap, -1 undo */
  taps: Array<{ delta: 1 | -1; at: number; judge: string; name?: string }>;
  challengeStart: number | null;
  outcome: 'SUCCESS' | 'FAILURE' | null;
  judge: string | null;
}
export interface AuctionState {
  mode: 'auction';
  players: string[];
  judges: string[];
  timing: Timing;
  items: AuctionItem[];
  rounds: Round[];
  r: number;
  phase: 'BIDDING' | 'AWAIT_JUDGE' | 'CHALLENGE' | 'ROUND_REVEAL' | 'DONE';
  phaseStart: number;
  phaseEnd: number | null;
  voided: number[];
  /** appeal ACCEPT flips the outcome in the claimant's favour */
  overrides: Record<string, 'SUCCESS' | 'FAILURE'>;
}

export function tapCount(round: Pick<Round, 'taps'>): number {
  return Math.max(
    0,
    round.taps.reduce((a, t) => a + t.delta, 0),
  );
}

function outcomeOf(s: AuctionState, r: number): 'SUCCESS' | 'FAILURE' | null {
  return s.overrides[String(r)] ?? s.rounds[r]!.outcome;
}

export function auctionRoundPoints(s: AuctionState, r: number): Record<string, number> {
  const round = s.rounds[r]!;
  const o = outcomeOf(s, r);
  if (s.voided.includes(r) || !o || !round.bidder) return {};
  if (o === 'SUCCESS') return { [round.bidder]: AUCTION_POINTS.success };
  const out: Record<string, number> = { [round.bidder]: AUCTION_POINTS.failBidder };
  if (round.lastDropper) out[round.lastDropper] = AUCTION_POINTS.failChallenger;
  return out;
}

function settledUpTo(s: AuctionState) {
  return s.phase === 'DONE' ? s.rounds.length : s.phase === 'ROUND_REVEAL' ? s.r + 1 : s.r;
}

function scores(s: AuctionState): Record<string, string> {
  const out: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
  for (let r = 0; r < settledUpTo(s); r++)
    for (const [m, p] of Object.entries(auctionRoundPoints(s, r))) out[m] = (out[m] ?? 0) + p;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)]));
}

function patchRound(s: AuctionState, patch: Partial<Round>): AuctionState {
  const rounds = [...s.rounds];
  rounds[s.r] = { ...rounds[s.r]!, ...patch };
  return { ...s, rounds };
}

function startRound(s: AuctionState, r: number, at: number): AuctionState {
  if (r >= s.rounds.length)
    return { ...s, r: s.rounds.length - 1, phase: 'DONE', phaseStart: at, phaseEnd: null };
  return { ...s, r, phase: 'BIDDING', phaseStart: at, phaseEnd: at + s.timing.auctionBid };
}

/** Next active player after `from` in seat order, excluding the current high bidder. */
function nextTurn(players: string[], active: string[], from: string, bidder: string | null): string {
  const n = players.length;
  const start = players.indexOf(from);
  for (let k = 1; k <= n; k++) {
    const p = players[(start + k) % n]!;
    if (active.includes(p) && p !== bidder) return p;
  }
  return from;
}

function applyBid(
  s: AuctionState,
  player: string,
  amount: number | 'DROP',
  at: number,
  auto: boolean,
): AuctionState {
  const round = s.rounds[s.r]!;
  const max = s.items[s.r]!.universe.length;
  const bids = [...round.bids, { player, amount, at, auto }];
  if (amount === 'DROP') {
    if (round.bidder === null) throw new GameError('RULE_VIOLATION', 'The opener must place an opening bid');
    const active = round.active.filter((p) => p !== player);
    const n = patchRound(s, { bids, active, lastDropper: player });
    if (active.length === 1 && active[0] === round.bidder) {
      return { ...n, phase: 'AWAIT_JUDGE', phaseStart: at, phaseEnd: at + s.timing.auctionJudgeStart };
    }
    return {
      ...patchRound(n, { turn: nextTurn(s.players, active, player, round.bidder) }),
      phaseStart: at,
      phaseEnd: at + s.timing.auctionBid,
    };
  }
  if (!Number.isInteger(amount) || amount <= round.bid || amount < 1)
    throw new GameError('RULE_VIOLATION', `Bid must be more than ${round.bid}`);
  if (amount > max) throw new GameError('RULE_VIOLATION', `Bid cannot exceed ${max}`);
  const n = patchRound(s, { bids, bid: amount, bidder: player });
  const others = round.active.filter((p) => p !== player);
  if (others.length === 0)
    return { ...n, phase: 'AWAIT_JUDGE', phaseStart: at, phaseEnd: at + s.timing.auctionJudgeStart };
  if (amount === max) {
    // Nobody can outbid the maximum; remaining players drop in seat order, the last one becomes challenger.
    const order = s.players.filter((p) => others.includes(p));
    return {
      ...patchRound(n, { active: [player], lastDropper: order[order.length - 1]! }),
      phase: 'AWAIT_JUDGE',
      phaseStart: at,
      phaseEnd: at + s.timing.auctionJudgeStart,
    };
  }
  return {
    ...patchRound(n, { turn: nextTurn(s.players, round.active, player, player) }),
    phaseStart: at,
    phaseEnd: at + s.timing.auctionBid,
  };
}

function startChallenge(s: AuctionState, at: number): AuctionState {
  return {
    ...patchRound(s, { challengeStart: at }),
    phase: 'CHALLENGE',
    phaseStart: at,
    phaseEnd: at + s.timing.auctionChallenge,
  };
}

function finishRound(s: AuctionState, outcome: 'SUCCESS' | 'FAILURE', at: number): AuctionState {
  return {
    ...patchRound(s, { outcome }),
    phase: 'ROUND_REVEAL',
    phaseStart: at,
    phaseEnd: at + s.timing.appealWindow,
  };
}

export const auctionEngine: Engine<AuctionState, AuctionItem> = {
  key: 'auction',
  contentKind: 'auction',
  supportedDecisions: ['ACCEPT', 'REJECT', 'VOID'] as AppealDecision[],
  itemsNeeded: (n) => n,
  init(ctx, items, now) {
    if (ctx.judges.length === 0)
      throw new GameError('INVALID_STATE', 'Football Auction requires a neutral judge');
    const rounds: Round[] = ctx.players.map((p) => ({
      opener: p,
      bid: 0,
      bidder: null,
      active: [...ctx.players],
      lastDropper: null,
      turn: p,
      bids: [],
      taps: [],
      challengeStart: null,
      outcome: null,
      judge: null,
    }));
    return startRound(
      {
        mode: 'auction',
        players: [...ctx.players],
        judges: [...ctx.judges],
        timing: ctx.timing,
        items: items.slice(0, rounds.length),
        rounds,
        r: 0,
        phase: 'BIDDING',
        phaseStart: now,
        phaseEnd: null,
        voided: [],
        overrides: {},
      },
      0,
      now,
    );
  },
  act(s, actor, action, now) {
    if (s.phaseEnd !== null && now >= s.phaseEnd) throw new GameError('DEADLINE_PASSED', 'Time is up');
    const round = s.rounds[s.r]!;
    if (action.type === 'bid' || action.type === 'drop') {
      if (s.phase !== 'BIDDING') throw new GameError('INVALID_STATE', 'Bidding is closed');
      if (actor.role !== 'PLAYER' || actor.memberId !== round.turn)
        throw new GameError('FORBIDDEN', 'Not your turn to bid');
      return applyBid(s, actor.memberId, action.type === 'drop' ? 'DROP' : Number(action.amount), now, false);
    }
    if (action.type === 'tap' || action.type === 'undo') {
      if (actor.role !== 'JUDGE' || !s.judges.includes(actor.memberId))
        throw new GameError('FORBIDDEN', 'Only the judge can count');
      if (s.phase !== 'AWAIT_JUDGE' && s.phase !== 'CHALLENGE')
        throw new GameError('INVALID_STATE', 'No challenge in progress');
      let n = s;
      if (s.phase === 'AWAIT_JUDGE') {
        if (action.type === 'undo') throw new GameError('INVALID_STATE', 'Nothing to undo');
        n = startChallenge(s, now); // 30s starts on the judge's first valid tap (approved)
      }
      const cur = n.rounds[n.r]!;
      if (action.type === 'undo' && tapCount(cur) === 0)
        throw new GameError('INVALID_STATE', 'Nothing to undo');
      const name = typeof action.name === 'string' ? action.name.slice(0, 80) : undefined;
      const taps = [
        ...cur.taps,
        {
          delta: (action.type === 'tap' ? 1 : -1) as 1 | -1,
          at: now,
          judge: actor.memberId,
          ...(name ? { name } : {}),
        },
      ];
      n = patchRound(n, { taps, judge: actor.memberId });
      // Undo never resets the timer (approved). Success is immediate once the count reaches the bid.
      if (tapCount({ taps }) >= cur.bid) return finishRound(n, 'SUCCESS', now);
      return n;
    }
    throw new GameError('INVALID_MESSAGE', 'Unknown action');
  },
  step(s, d) {
    const round = s.rounds[s.r]!;
    if (s.phase === 'BIDDING') return applyBid(s, round.turn, round.bidder === null ? 1 : 'DROP', d, true);
    if (s.phase === 'AWAIT_JUDGE') return startChallenge(s, d); // PROPOSED auto-start
    if (s.phase === 'CHALLENGE')
      return finishRound(s, tapCount(round) >= round.bid ? 'SUCCESS' : 'FAILURE', d);
    if (s.phase === 'ROUND_REVEAL') return startRound(s, s.r + 1, d);
    return s;
  },
  nextDeadline: (s) => (s.phase === 'DONE' ? null : s.phaseEnd),
  finished: (s) => s.phase === 'DONE',
  atBoundary: (s) => s.phase === 'ROUND_REVEAL',
  scores,
  ranking: (s) => groupByScore(scores(s), s.players),
  appealWindows(s, now) {
    if (s.phase !== 'ROUND_REVEAL' || s.phaseEnd === null || now >= s.phaseEnd) return [];
    const round = s.rounds[s.r]!;
    const eligible = [round.bidder, round.lastDropper].filter((x): x is string => !!x);
    return [{ itemIndex: s.r, closesAt: s.phaseEnd, eligible }];
  },
  adjudicate(s, adj) {
    if (adj.decision === 'VOID')
      return s.voided.includes(adj.itemIndex) ? s : { ...s, voided: [...s.voided, adj.itemIndex] };
    if (adj.decision === 'ACCEPT') {
      const round = s.rounds[adj.itemIndex]!;
      const favour =
        adj.claimantId === round.bidder ? 'SUCCESS' : adj.claimantId === round.lastDropper ? 'FAILURE' : null;
      if (!favour) throw new GameError('RULE_VIOLATION', 'Claimant not involved in this auction');
      return { ...s, overrides: { ...s.overrides, [String(adj.itemIndex)]: favour } };
    }
    return s;
  },
  gradedBy: (s, i) => s.rounds[i]?.judge ?? null,
  view(s, viewer) {
    const round = s.rounds[s.r]!;
    const item = s.items[s.r]!;
    const isJudge = viewer.role === 'JUDGE' && viewer.memberId !== null && s.judges.includes(viewer.memberId);
    const over = s.phase === 'ROUND_REVEAL' || s.phase === 'DONE';
    return {
      mode: 'auction',
      phase: s.phase,
      round: s.r,
      roundCount: s.rounds.length,
      phaseStart: s.phaseStart,
      phaseEnd: s.phaseEnd,
      category: item.category,
      scope: item.scope,
      maxBid: item.universe.length,
      opener: round.opener,
      turn: s.phase === 'BIDDING' ? round.turn : null,
      bid: round.bid,
      bidder: round.bidder,
      challenger: s.phase === 'BIDDING' ? null : round.lastDropper,
      active: round.active,
      bids: round.bids.map((b) => ({ player: b.player, amount: b.amount, auto: b.auto })),
      count: tapCount(round),
      namesCounted:
        isJudge || over
          ? round.taps.filter((t) => t.name).map((t) => ({ delta: t.delta, name: t.name }))
          : [],
      // The answer universe is a judging aid only: judge always, others after the round.
      universe: isJudge || over ? item.universe.map((u) => u.label) : null,
      outcome: over ? outcomeOf(s, s.r) : null,
      roundPoints: over ? auctionRoundPoints(s, s.r) : null,
      voided: s.voided.includes(s.r),
      attribution: over ? item.meta.attribution : null,
      scores: scores(s),
    };
  },
};
