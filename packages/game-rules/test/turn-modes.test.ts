import { describe, expect, it } from 'vitest';
import {
  auctionEngine,
  buzzerEngine,
  DEFAULT_TIMING as T,
  duelPoints,
  impostorEngine,
  isCaught,
  riskItEngine,
  riskPoints,
  snakeOrder,
  timelineEngine,
  timelinePairings,
  top25Engine,
} from '../src/index.js';
import { auction, ctx, imp, mcq, P, runTo, shortA, tl, top25 } from './fixtures.js';

const pl = (m: string) => P('PLAYER', m);
const judge = P('JUDGE', 'j');

describe('Risk It (PROVISIONAL turn order/defaults)', () => {
  it('approved payoffs', () => {
    expect([riskPoints('SAFE', true), riskPoints('SAFE', false)]).toEqual([1, 0]);
    expect([riskPoints('BOLD', true), riskPoints('BOLD', false)]).toEqual([3, -1]);
    expect([riskPoints('ALL_IN', true), riskPoints('ALL_IN', false)]).toEqual([6, -3]);
  });
  it('6 turns each, negatives allowed, risk timeout => SAFE, answer timeout => wrong', () => {
    const items = Array.from({ length: 12 }, (_, i) => mcq(i));
    let s = riskItEngine.init(ctx(['a', 'b']), items, 0);
    expect(s.turns.length).toBe(12);
    expect(() => riskItEngine.act(s, pl('b'), { type: 'risk', risk: 'BOLD' }, 1)).toThrow(/Not your turn/);
    // a: ALL IN, wrong -> -3
    s = riskItEngine.act(s, pl('a'), { type: 'risk', risk: 'ALL_IN' }, 1);
    s = riskItEngine.act(s, pl('a'), { type: 'answer', optionId: 'o2' }, 2);
    s = runTo(riskItEngine, s, s.phaseEnd!);
    // b: no risk chosen -> SAFE; no answer -> wrong -> 0
    s = runTo(riskItEngine, s, s.phaseStart + T.riskChoose);
    expect(s.turns[1]!.risk).toBe('SAFE');
    expect(s.turns[1]!.riskDefaulted).toBe(true);
    s = runTo(riskItEngine, s, s.phaseStart + T.riskAnswer + T.appealWindow);
    expect(riskItEngine.scores(s)).toEqual({ a: '-3', b: '0' });
    // a: BOLD correct +3 -> 0
    s = riskItEngine.act(s, pl('a'), { type: 'risk', risk: 'BOLD' }, s.phaseStart + 1);
    s = riskItEngine.act(s, pl('a'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1);
    expect(riskItEngine.scores(s).a).toBe('0');
    // ACCEPT on turn 0 regrades ALL IN wrong -> +6
    expect(
      riskItEngine.scores(riskItEngine.adjudicate(s, { itemIndex: 0, claimantId: 'a', decision: 'ACCEPT' }))
        .a,
    ).toBe('9');
    s = runTo(riskItEngine, s, 1e9);
    expect(riskItEngine.finished(s)).toBe(true);
  });
  it('question is hidden while choosing risk; answer hidden until reveal', () => {
    const s = riskItEngine.init(ctx(['a', 'b']), [mcq(0), mcq(1)], 0);
    expect((riskItEngine.view(s, { memberId: 'b', role: 'PLAYER' }, 1) as any).item).toBeNull();
    const s2 = riskItEngine.act(s, pl('a'), { type: 'risk', risk: 'SAFE' }, 1);
    expect(
      (riskItEngine.view(s2, { memberId: 'b', role: 'PLAYER' }, 2) as any).item.correctOptionId,
    ).toBeNull();
  });
});

describe('Timeline duels', () => {
  it('approved duel payoffs', () => {
    expect(duelPoints(true, false)).toEqual([3, 0]);
    expect(duelPoints(false, true)).toEqual([0, 3]);
    expect(duelPoints(true, true)).toEqual([1, 1]);
    expect(duelPoints(false, false)).toEqual([0, 0]);
  });
  it('balanced pairings: each initiates 2 and receives 2 (N>=3)', () => {
    for (const n of [3, 4, 5, 6]) {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      const pairs = timelinePairings(players);
      expect(pairs.length).toBe(2 * n);
      for (const p of players) {
        expect(pairs.filter(([a]) => a === p).length).toBe(2);
        expect(pairs.filter(([, b]) => b === p).length).toBe(2);
      }
      expect(pairs.every(([a, b]) => a !== b)).toBe(true);
    }
    expect(timelinePairings(['a', 'b'])).toEqual([
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });
  it('8s answer window, only duelists answer, picks hidden until reveal', () => {
    let s = timelineEngine.init(
      ctx(['a', 'b', 'c']),
      Array.from({ length: 6 }, (_, i) => tl(i)),
      0,
    );
    s = timelineEngine.step(s, T.timelineIntro);
    expect(() => timelineEngine.act(s, pl('c'), { type: 'pick', eventId: 'e1' }, 3001)).toThrow(
      /not in this duel/,
    );
    s = timelineEngine.act(s, pl('a'), { type: 'pick', eventId: 'e1' }, 3001);
    expect((timelineEngine.view(s, { memberId: 'b', role: 'PLAYER' }, 3002) as any).picks.a).toBe('HIDDEN');
    s = timelineEngine.step(s, s.phaseEnd!); // b times out
    expect(timelineEngine.scores(s)).toEqual({ a: '3', b: '0', c: '0' });
  });
});

describe('TOP 25 (PROVISIONAL end conditions)', () => {
  it('snake order alternates direction', () => {
    expect(snakeOrder(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(snakeOrder(['a', 'b', 'c'], 1)).toEqual(['c', 'b', 'a']);
  });
  it('rank N = N points; wrong/duplicate/timeout 0; reaching 100 completes the equal-turn cycle', () => {
    let s = top25Engine.init(ctx(['a', 'b']), [top25()], 0);
    const guess = (m: string, text: string) => {
      s = top25Engine.act(s, pl(m), { type: 'guess', text }, s.phaseStart + 1);
      s = top25Engine.step(s, s.phaseEnd!);
    };
    guess('a', 'Name 25'); // 25
    expect(() => top25Engine.act(s, pl('a'), { type: 'guess', text: 'x' }, s.phaseStart + 1)).toThrow(
      /Not your turn/,
    );
    guess('b', 'name 25'); // duplicate
    expect(s.guesses[1]!.duplicate).toBe(true);
    // round 1 is reversed: b then a
    guess('b', 'Nobody'); // wrong
    guess('a', 'Name 24'); // 49
    guess('a', 'Name 23'); // round 2: a first -> 72
    s = top25Engine.step(s, s.phaseEnd!); // b times out
    s = top25Engine.step(s, s.phaseEnd!);
    guess('b', 'Name 1'); // round 3 reversed: b, a
    guess('a', 'Name 22'); // a = 94
    guess('a', 'Name 21'); // round 4: a -> 115 (>=100) ; b still gets a turn
    expect(top25Engine.finished(s)).toBe(false);
    guess('b', 'Name 20');
    expect(top25Engine.finished(s)).toBe(true);
    expect(s.endReason).toBe('TARGET');
    expect(top25Engine.scores(s)).toEqual({ a: '115', b: '21' });
  });
  it('hidden grid never reveals unfound names; appeal ACCEPT needs an unclaimed rank', () => {
    let s = top25Engine.init(ctx(['a', 'b']), [top25()], 0);
    s = top25Engine.act(s, pl('a'), { type: 'guess', text: 'Nam 5' }, 10);
    const v = JSON.stringify(top25Engine.view(s, { memberId: null, role: 'SPECTATOR' }, 11));
    expect(v).not.toContain('Name ');
    expect(top25Engine.appealWindows(s, 11)).toEqual([
      { itemIndex: 0, closesAt: 10 + T.appealWindow, eligible: ['a'] },
    ]);
    expect(() => top25Engine.adjudicate(s, { itemIndex: 0, claimantId: 'a', decision: 'ACCEPT' })).toThrow(
      /rank/,
    );
    const acc = top25Engine.adjudicate(s, { itemIndex: 0, claimantId: 'a', decision: 'ACCEPT', detail: 5 });
    expect(top25Engine.scores(acc).a).toBe('5');
  });
  it('ends when the list is exhausted', () => {
    let s = top25Engine.init(ctx(['a', 'b']), [top25()], 0);
    for (let r = 1; r <= 25; r++) {
      const who = (top25Engine.view(s, { memberId: null, role: 'SPECTATOR' }, 0) as any).player;
      s = top25Engine.act(s, pl(who), { type: 'guess', text: `Name ${r}` }, s.phaseStart + 1);
      s = top25Engine.step(s, s.phaseEnd!);
      if (top25Engine.finished(s)) break;
    }
    expect(['EXHAUSTED', 'TARGET']).toContain(s.endReason);
  });
});

describe('Buzzer Battle (judge required)', () => {
  const items = Array.from({ length: 10 }, (_, i) => shortA(i));
  it('requires a judge', () => expect(() => buzzerEngine.init(ctx(['a', 'b']), items, 0)).toThrow(/judge/));
  it('first buzz wins the floor; wrong -1 reopens once each; correct +3', () => {
    let s = buzzerEngine.init(ctx(['a', 'b', 'c'], ['j']), items, 0);
    s = buzzerEngine.act(s, pl('b'), { type: 'buzz' }, 1000);
    expect(() => buzzerEngine.act(s, pl('a'), { type: 'buzz' }, 1001)).toThrow(/closed/); // deterministic: b first
    expect(() => buzzerEngine.act(s, pl('b'), { type: 'verdict', verdict: 'CORRECT' }, 1500)).toThrow(
      /Only the judge/,
    );
    expect(() => buzzerEngine.act(s, judge, { type: 'verdict', verdict: 'TIMEOUT' }, 2000)).toThrow(
      /not expired/,
    );
    s = buzzerEngine.act(s, judge, { type: 'verdict', verdict: 'WRONG' }, 3000);
    expect(s.phase).toBe('OPEN');
    expect(() => buzzerEngine.act(s, pl('b'), { type: 'buzz' }, 3001)).toThrow(/Already used/);
    s = buzzerEngine.act(s, pl('c'), { type: 'buzz' }, 3002);
    s = buzzerEngine.act(s, judge, { type: 'verdict', verdict: 'CORRECT' }, 4000);
    expect(s.phase).toBe('REVEAL');
    expect(buzzerEngine.scores(s)).toEqual({ a: '0', b: '-1', c: '3' });
    expect(buzzerEngine.appealWindows(s, 4001)[0]!.eligible).toEqual(['b']);
    expect(buzzerEngine.gradedBy(s, 0, 'b')).toBe('j');
  });
  it('no buzz => no points; no verdict in time => buzz void', () => {
    let s = buzzerEngine.init(ctx(['a', 'b'], ['j']), items, 0);
    s = buzzerEngine.step(s, T.buzzerOpen);
    expect(s.phase).toBe('REVEAL');
    s = buzzerEngine.step(s, s.phaseEnd!);
    s = buzzerEngine.act(s, pl('a'), { type: 'buzz' }, s.phaseStart + 1);
    s = buzzerEngine.step(s, s.phaseEnd!);
    expect(s.q[1]!.buzzes[0]!.verdict).toBe('VOID');
    expect(buzzerEngine.scores(s)).toEqual({ a: '0', b: '0' });
  });
  it('answer key only for the judge before reveal', () => {
    const s = buzzerEngine.init(ctx(['a', 'b'], ['j']), items, 0);
    expect((buzzerEngine.view(s, { memberId: 'j', role: 'JUDGE' }, 1) as any).answer).toBe('Answer 0');
    expect((buzzerEngine.view(s, { memberId: 'a', role: 'PLAYER' }, 1) as any).answer).toBeNull();
    expect(JSON.stringify(buzzerEngine.view(s, { memberId: null, role: 'SPECTATOR' }, 1))).not.toContain(
      'Answer 0',
    );
  });
});

describe('The Impostor', () => {
  const items = Array.from({ length: 3 }, (_, i) => imp(i));
  it('needs 3+ players', () =>
    expect(() => impostorEngine.init(ctx(['a', 'b']), items, 0)).toThrow(/3 players/));
  it('caught = strictly most votes', () => {
    expect(isCaught({ a: 'c', b: 'c', c: 'a' }, 'c')).toBe(true);
    expect(isCaught({ a: 'c', b: 'a', c: 'b' }, 'c')).toBe(false); // 3-way tie
    expect(isCaught({}, 'c')).toBe(false);
  });
  it('secret delivery: impostor & spectators never see the footballer during the round', () => {
    const s = impostorEngine.init(ctx(['a', 'b', 'c'], [], 42), items, 0);
    const impostor = s.rounds[0]!.impostor;
    const crew = ['a', 'b', 'c'].find((m) => m !== impostor)!;
    const vi = impostorEngine.view(s, { memberId: impostor, role: 'PLAYER' }, 1) as any;
    const vc = impostorEngine.view(s, { memberId: crew, role: 'PLAYER' }, 1) as any;
    const vs = impostorEngine.view(s, { memberId: null, role: 'SPECTATOR' }, 1) as any;
    expect(vi.role).toBe('IMPOSTOR');
    expect(vi.footballer).toBeNull();
    expect(vc.footballer).toBe('Star 0');
    expect(vs.footballer).toBeNull();
    for (const v of [vc, vs]) expect(v.impostor).toBeNull();
    expect(JSON.stringify(vs)).not.toContain('Star 0');
    expect(JSON.stringify(vs)).not.toContain('IMPOSTOR');
  });
  it('full round timeline and scoring: votes +2, caught-and-guessed +3; votes private until reveal', () => {
    let s = impostorEngine.init(ctx(['a', 'b', 'c'], [], 42), items, 0);
    const impostor = s.rounds[0]!.impostor;
    const crew = ['a', 'b', 'c'].filter((m) => m !== impostor);
    // reveal 15s, 2 cycles x 3 players x 10s, discussion 45s
    s = runTo(impostorEngine, s, T.impostorReveal + 6 * T.impostorClue + T.impostorDiscussion);
    expect(s.phase).toBe('VOTE');
    expect(() =>
      impostorEngine.act(s, pl(crew[0]!), { type: 'vote', target: crew[0] }, s.phaseStart + 1),
    ).toThrow(/yourself/);
    s = impostorEngine.act(s, pl(crew[0]!), { type: 'vote', target: impostor }, s.phaseStart + 1);
    expect(
      (impostorEngine.view(s, { memberId: crew[1]!, role: 'PLAYER' }, s.phaseStart + 2) as any).votes,
    ).toBeNull();
    s = impostorEngine.act(s, pl(crew[1]!), { type: 'vote', target: impostor }, s.phaseStart + 2);
    s = impostorEngine.act(s, pl(impostor), { type: 'vote', target: crew[0] }, s.phaseStart + 3);
    expect(s.phase).toBe('GUESS');
    expect(
      (impostorEngine.view(s, { memberId: impostor, role: 'PLAYER' }, s.phaseStart + 1) as any).footballer,
    ).toBeNull();
    s = impostorEngine.act(s, pl(impostor), { type: 'guess', text: 's0' }, s.phaseStart + 1);
    expect(s.phase).toBe('ROUND_REVEAL');
    const sc = impostorEngine.scores(s);
    expect(sc[impostor]).toBe('3');
    expect(sc[crew[0]!]).toBe('2');
    expect(sc[crew[1]!]).toBe('2');
  });
  it('escape +4 when not caught; each player is impostor exactly once', () => {
    let s = impostorEngine.init(ctx(['a', 'b', 'c'], [], 7), items, 0);
    expect(new Set(s.rounds.map((r) => r.impostor)).size).toBe(3);
    const impostor = s.rounds[0]!.impostor;
    s = runTo(
      impostorEngine,
      s,
      T.impostorReveal + 6 * T.impostorClue + T.impostorDiscussion + T.impostorVote,
    );
    expect(s.phase).toBe('ROUND_REVEAL');
    expect(impostorEngine.scores(s)[impostor]).toBe('4');
  });
});

describe('Football Auction + 30 Seconds (judge required)', () => {
  const items = [auction(0), auction(1)];
  it('last bidder challenged by last dropper; success +5 immediately on reaching the bid', () => {
    let s = auctionEngine.init(ctx(['a', 'b'], ['j']), items, 0);
    expect(() => auctionEngine.act(s, pl('a'), { type: 'drop' }, 1)).toThrow(/opening bid/);
    s = auctionEngine.act(s, pl('a'), { type: 'bid', amount: 2 }, 1);
    expect(() => auctionEngine.act(s, pl('b'), { type: 'bid', amount: 2 }, 2)).toThrow(/more than 2/);
    s = auctionEngine.act(s, pl('b'), { type: 'bid', amount: 3 }, 2);
    s = auctionEngine.act(s, pl('a'), { type: 'drop' }, 3);
    expect(s.phase).toBe('AWAIT_JUDGE');
    expect(s.rounds[0]!.bidder).toBe('b');
    expect(s.rounds[0]!.lastDropper).toBe('a');
    // 30s starts on judge's first valid tap
    s = auctionEngine.act(s, judge, { type: 'tap', name: 'U1' }, 5000);
    expect(s.phase).toBe('CHALLENGE');
    expect(s.phaseEnd).toBe(5000 + T.auctionChallenge);
    s = auctionEngine.act(s, judge, { type: 'tap' }, 6000);
    s = auctionEngine.act(s, judge, { type: 'undo' }, 7000);
    expect(s.phaseEnd).toBe(5000 + T.auctionChallenge); // undo never resets timer
    s = auctionEngine.act(s, judge, { type: 'tap' }, 8000);
    s = auctionEngine.act(s, judge, { type: 'tap' }, 9000);
    expect(s.phase).toBe('ROUND_REVEAL');
    expect(auctionEngine.scores(s)).toEqual({ a: '0', b: '5' });
  });
  it('failure: bidder -2, challenger +5; bid timeouts drop; universe hidden from players', () => {
    let s = auctionEngine.init(ctx(['a', 'b', 'c'], ['j']), [auction(0), auction(1), auction(2)], 0);
    expect((auctionEngine.view(s, { memberId: 'a', role: 'PLAYER' }, 1) as any).universe).toBeNull();
    expect((auctionEngine.view(s, { memberId: 'j', role: 'JUDGE' }, 1) as any).universe).toHaveLength(10);
    s = auctionEngine.act(s, pl('a'), { type: 'bid', amount: 4 }, 1);
    s = auctionEngine.act(s, pl('b'), { type: 'drop' }, 2);
    s = auctionEngine.step(s, s.phaseEnd!); // c times out -> drop
    expect(s.rounds[0]!.lastDropper).toBe('c');
    s = auctionEngine.step(s, s.phaseEnd!); // judge never taps -> auto start
    s = auctionEngine.act(s, judge, { type: 'tap' }, s.phaseStart + 10);
    s = auctionEngine.step(s, s.phaseEnd!); // 30s over, 1 < 4
    expect(s.rounds[0]!.outcome).toBe('FAILURE');
    expect(auctionEngine.scores(s)).toEqual({ a: '-2', b: '0', c: '5' });
    // appeal by bidder accepted flips to success
    expect(
      auctionEngine.scores(
        auctionEngine.adjudicate(s, { itemIndex: 0, claimantId: 'a', decision: 'ACCEPT' }),
      ),
    ).toEqual({ a: '5', b: '0', c: '0' });
    expect(auctionEngine.gradedBy(s, 0, 'a')).toBe('j');
  });
  it('a max bid ends bidding immediately', () => {
    let s = auctionEngine.init(ctx(['a', 'b', 'c'], ['j']), [auction(0, 3), auction(1), auction(2)], 0);
    expect(() => auctionEngine.act(s, pl('a'), { type: 'bid', amount: 4 }, 1)).toThrow(/exceed 3/);
    s = auctionEngine.act(s, pl('a'), { type: 'bid', amount: 3 }, 1);
    expect(s.phase).toBe('AWAIT_JUDGE');
    expect(s.rounds[0]!.lastDropper).toBe('c');
  });
});
