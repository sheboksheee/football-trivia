import { describe, expect, it } from 'vitest';
import {
  connectionsEngine, DEFAULT_TIMING as T, guessTheMatchEngine, higherLowerEngine, higherLowerScore,
  lastManStandingEngine, missingXiEngine, tiebreakEngine,
} from '../src/index.js';
import { conn, ctx, gm, hl, mcq, P, runTo, xi } from './fixtures.js';

const pl = (m: string) => P('PLAYER', m);

describe('Higher or Lower (APPROVED)', () => {
  it('score table: +2 each, pairs (1,2)/(3,4) +1, perfect +3, max 15', () => {
    expect(higherLowerScore([true, true, true, true, true])).toBe(15);
    expect(higherLowerScore([true, true, false, true, true])).toBe(9); // 8 + pair(1,2)
    expect(higherLowerScore([false, true, true, false, true])).toBe(6); // no pairs (2,3) overlap rule
    expect(higherLowerScore([true, true, true, true, false])).toBe(10); // 8 + 2 pairs
    expect(higherLowerScore([false, false, false, false, false])).toBe(0);
    expect(higherLowerScore([true, null, true, true, true])).toBe(9); // voided Q2 breaks pair & perfect
  });

  const items = [hl(0, 5, 9), hl(1, 9, 2), hl(2, 1, 3), hl(3, 7, 6), hl(4, 2, 8)];
  const right = ['HIGHER', 'LOWER', 'HIGHER', 'LOWER', 'HIGHER'];

  it('plays 5 comparisons with 10s timers; timeouts are wrong', () => {
    let s = higherLowerEngine.init(ctx(['a', 'b']), items, 0);
    for (let i = 0; i < 5; i++) {
      const t0 = s.phaseStart;
      s = higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: right[i] }, t0 + 1000);
      // b never answers -> times out at 10s
      expect(s.phase).toBe('QUESTION');
      s = higherLowerEngine.step(s, t0 + T.higherLowerQuestion);
      expect(s.phase).toBe('REVEAL');
      s = higherLowerEngine.step(s, s.phaseEnd!);
    }
    expect(higherLowerEngine.finished(s)).toBe(true);
    expect(higherLowerEngine.scores(s)).toEqual({ a: '15', b: '0' });
    expect(higherLowerEngine.ranking(s)).toEqual([['a'], ['b']]);
  });

  it('closes early when everyone answered; rejects late, duplicate, stale and non-player answers', () => {
    let s = higherLowerEngine.init(ctx(['a', 'b']), items, 0);
    expect(() => higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: 'UP' }, 1)).toThrow(/HIGHER or LOWER/);
    expect(() => higherLowerEngine.act(s, P('SPECTATOR', 'x'), { type: 'answer', choice: 'HIGHER' }, 1)).toThrow(/Only players/);
    expect(() => higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: 'HIGHER', itemIndex: 3 }, 1)).toThrow(/different question/);
    s = higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: 'HIGHER' }, 100);
    expect(() => higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: 'LOWER' }, 200)).toThrow(/locked/);
    expect(() => higherLowerEngine.act(s, pl('b'), { type: 'answer', choice: 'LOWER' }, T.higherLowerQuestion)).toThrow(/Time is up/);
    s = higherLowerEngine.act(s, pl('b'), { type: 'answer', choice: 'LOWER' }, 300);
    expect(s.phase).toBe('REVEAL');
    expect(s.phaseEnd).toBe(300 + T.appealWindow);
  });

  it('never leaks B value, correctness or other answers before reveal', () => {
    let s = higherLowerEngine.init(ctx(['a', 'b']), items, 0);
    s = higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: 'HIGHER' }, 100);
    const v = higherLowerEngine.view(s, { memberId: 'b', role: 'PLAYER' }, 200) as Record<string, any>;
    expect(v.item.b.value).toBeNull();
    expect(v.item.correct).toBeNull();
    expect(v.submissions.a).toEqual({ answered: true });
    expect(v.scores).toEqual({ a: '0', b: '0' }); // live score must not reveal correctness
    const own = higherLowerEngine.view(s, { memberId: 'a', role: 'PLAYER' }, 200) as Record<string, any>;
    expect(own.submissions.a.answer).toBe('HIGHER');
    expect(own.submissions.a.correct).toBeUndefined();
    const spec = JSON.stringify(higherLowerEngine.view(s, { memberId: null, role: 'SPECTATOR' }, 200));
    expect(spec).not.toContain('"value":9');
  });

  it('appeal adjudication: ACCEPT regrades claimant; VOID removes question for all', () => {
    let s = higherLowerEngine.init(ctx(['a', 'b']), items, 0);
    s = higherLowerEngine.act(s, pl('a'), { type: 'answer', choice: 'HIGHER' }, 1);
    s = higherLowerEngine.act(s, pl('b'), { type: 'answer', choice: 'LOWER' }, 2);
    expect(higherLowerEngine.appealWindows(s, 3)).toEqual([{ itemIndex: 0, closesAt: 2 + T.appealWindow, eligible: ['a', 'b'] }]);
    expect(higherLowerEngine.appealWindows(s, 2 + T.appealWindow)).toEqual([]);
    const acc = higherLowerEngine.adjudicate(s, { itemIndex: 0, claimantId: 'b', decision: 'ACCEPT' });
    expect(higherLowerEngine.scores(acc)).toEqual({ a: '2', b: '2' });
    const voided = higherLowerEngine.adjudicate(s, { itemIndex: 0, claimantId: 'b', decision: 'VOID' });
    expect(higherLowerEngine.scores(voided)).toEqual({ a: '0', b: '0' });
    expect(higherLowerEngine.adjudicate(s, { itemIndex: 0, claimantId: 'b', decision: 'REJECT' })).toBe(s);
  });

  it('ties share a ranking group', () => {
    let s = higherLowerEngine.init(ctx(['a', 'b', 'c']), items, 0);
    s = runTo(higherLowerEngine, s, 1e9);
    expect(higherLowerEngine.ranking(s)).toEqual([['a', 'b', 'c']]);
  });
});

describe('Last Man Standing (PROVISIONAL ordering)', () => {
  const items = Array.from({ length: 15 }, (_, i) => mcq(i));
  it('3 hearts, wrong/timeout loses a heart, ends at <=1 alive, placement 5/3/1 + perfect bonus', () => {
    let s = lastManStandingEngine.init(ctx(['a', 'b', 'c']), items, 0);
    const answer = (m: string, opt: string) => (s = lastManStandingEngine.act(s, pl(m), { type: 'answer', optionId: opt }, s.phaseStart + 10));
    // Q1: a right, b wrong, c timeout
    answer('a', 'o1'); answer('b', 'o2');
    s = runTo(lastManStandingEngine, s, s.phaseStart + T.lmsQuestion + T.appealWindow);
    expect(s.extra.public.hearts).toEqual({ a: 3, b: 2, c: 2 });
    // Q2, Q3: a right; b wrong; c wrong -> b and c eliminated at the same question (index 2)
    for (let q = 0; q < 2; q++) {
      answer('a', 'o1'); answer('b', 'o3'); answer('c', 'o4');
      s = runTo(lastManStandingEngine, s, s.phaseEnd!);
    }
    expect(s.extra.public.hearts).toEqual({ a: 3, b: 0, c: 0 });
    expect(lastManStandingEngine.finished(s)).toBe(true);
    expect(lastManStandingEngine.ranking(s)).toEqual([['a'], ['b', 'c']]);
    // a: 5 + perfect 1 ; b,c share 2nd/3rd: (3+1)/2 = 2
    expect(lastManStandingEngine.scores(s)).toEqual({ a: '6', b: '2', c: '2' });
  });
  it('eliminated players are not eligible for later questions', () => {
    let s = lastManStandingEngine.init(ctx(['a', 'b', 'c']), items, 0);
    for (let q = 0; q < 3; q++) {
      s = lastManStandingEngine.act(s, pl('c'), { type: 'answer', optionId: 'o2' }, s.phaseStart + 1);
      s = lastManStandingEngine.act(s, pl('a'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1);
      s = lastManStandingEngine.act(s, pl('b'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1);
      s = runTo(lastManStandingEngine, s, s.phaseEnd!);
    }
    expect(s.eligibleByItem[3]).toEqual(['a', 'b']);
    expect(() => lastManStandingEngine.act(s, pl('c'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1)).toThrow(/not answering/);
  });
  it('a voided question costs no hearts; runs at most 15 questions', () => {
    let s = lastManStandingEngine.init(ctx(['a', 'b']), items, 0);
    s = runTo(lastManStandingEngine, s, T.lmsQuestion); // both time out
    s = lastManStandingEngine.adjudicate(s, { itemIndex: 0, claimantId: 'a', decision: 'VOID' });
    s = runTo(lastManStandingEngine, s, s.phaseEnd!);
    expect(s.extra.public.hearts).toEqual({ a: 3, b: 3 });
    // everyone always correct -> 15 questions then end, both perfect and tied
    while (!lastManStandingEngine.finished(s)) {
      s = lastManStandingEngine.act(s, pl('a'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1);
      s = lastManStandingEngine.act(s, pl('b'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1);
      s = runTo(lastManStandingEngine, s, s.phaseEnd!);
    }
    expect(s.answers.length).toBe(15);
    expect(lastManStandingEngine.scores(s)).toEqual({ a: '5', b: '5' }); // (5+3)/2 + 1
  });
});

describe('Missing XI (APPROVED)', () => {
  const items = Array.from({ length: 10 }, (_, i) => xi(i));
  it('+5/+3/+1 by hints viewed; hints only at 8s and 14s; one irreversible answer', () => {
    let s = missingXiEngine.init(ctx(['a', 'b', 'c', 'd']), items, 0);
    expect(() => missingXiEngine.act(s, pl('b'), { type: 'hint' }, 7999)).toThrow(/not available/);
    s = missingXiEngine.act(s, pl('a'), { type: 'answer', text: 'missing 0' }, 1000);
    s = missingXiEngine.act(s, pl('b'), { type: 'hint' }, 8000);
    expect(() => missingXiEngine.act(s, pl('b'), { type: 'hint' }, 9000)).toThrow(/not available/);
    s = missingXiEngine.act(s, pl('b'), { type: 'answer', text: 'M0' }, 9000);
    s = missingXiEngine.act(s, pl('c'), { type: 'hint' }, 8000);
    s = missingXiEngine.act(s, pl('c'), { type: 'hint' }, 14000);
    expect(() => missingXiEngine.act(s, pl('c'), { type: 'hint' }, 15000)).toThrow(/No more hints/);
    s = missingXiEngine.act(s, pl('c'), { type: 'answer', text: 'Missing 0' }, 15000);
    expect(() => missingXiEngine.act(s, pl('c'), { type: 'answer', text: 'x' }, 15001)).toThrow(/locked/);
    s = missingXiEngine.act(s, pl('d'), { type: 'answer', text: 'Someone Else' }, 15000);
    s = runTo(missingXiEngine, s, s.phaseEnd!);
    expect(missingXiEngine.scores(s)).toEqual({ a: '5', b: '3', c: '1', d: '0' });
  });
  it('hint text is private to the viewer and answer hidden until reveal', () => {
    let s = missingXiEngine.init(ctx(['a', 'b']), items, 0);
    s = missingXiEngine.act(s, pl('a'), { type: 'hint' }, 8000);
    const va = missingXiEngine.view(s, { memberId: 'a', role: 'PLAYER' }, 8001) as any;
    const vb = missingXiEngine.view(s, { memberId: 'b', role: 'PLAYER' }, 8001) as any;
    expect(va.item.hints).toEqual(['Shirt 8']);
    expect(vb.item.hints).toEqual([]);
    expect(vb.item.answer).toBeNull();
    expect(JSON.stringify(vb)).not.toContain('Missing 0');
  });
});

describe('Guess the Match (APPROVED)', () => {
  const items = Array.from({ length: 8 }, (_, i) => gm(i));
  it('clues at 0/10/20s; +5/+3/+1 by tier; no speed bonus; wrong 0', () => {
    let s = guessTheMatchEngine.init(ctx(['a', 'b', 'c', 'd']), items, 0);
    expect((guessTheMatchEngine.view(s, { memberId: 'a', role: 'PLAYER' }, 9999) as any).item.clues).toEqual(['c1']);
    expect(guessTheMatchEngine.nextDeadline(s)).toBe(10000); // milestone for clue 2
    s = guessTheMatchEngine.act(s, pl('a'), { type: 'answer', optionId: 'm2' }, 9999);
    s = guessTheMatchEngine.step(s, 10000);
    expect(s.phase).toBe('QUESTION');
    s = guessTheMatchEngine.act(s, pl('b'), { type: 'answer', optionId: 'm2' }, 10000);
    s = guessTheMatchEngine.act(s, pl('c'), { type: 'answer', optionId: 'm2' }, 25000);
    s = guessTheMatchEngine.act(s, pl('d'), { type: 'answer', optionId: 'm1' }, 100);
    s = runTo(guessTheMatchEngine, s, s.phaseEnd!);
    expect(guessTheMatchEngine.scores(s)).toEqual({ a: '5', b: '3', c: '1', d: '0' });
  });
  it('future clues never reach clients', () => {
    const s = guessTheMatchEngine.init(ctx(['a', 'b']), items, 0);
    expect(JSON.stringify(guessTheMatchEngine.view(s, { memberId: null, role: 'SPECTATOR' }, 5))).not.toMatch(/c2|c3|"correctOptionId":"m2"/);
  });
});

describe('Connections (PROVISIONAL attempts)', () => {
  const items = Array.from({ length: 8 }, (_, i) => conn(i));
  it('earliest correct +3, other correct +2, ordered by submission time not grading', () => {
    let s = connectionsEngine.init(ctx(['a', 'b', 'c']), items, 0);
    s = connectionsEngine.act(s, pl('b'), { type: 'answer', text: 'link 0' }, 500);
    s = connectionsEngine.act(s, pl('a'), { type: 'answer', text: 'L0' }, 900);
    s = connectionsEngine.act(s, pl('c'), { type: 'answer', text: 'nope' }, 1000);
    expect(s.phase).toBe('REVEAL'); // no judge -> unmatched graded wrong
    expect(connectionsEngine.scores(s)).toEqual({ a: '2', b: '3', c: '0' });
  });
  it('with a judge, unmatched answers go to review; an accepted earlier alternative takes +3', () => {
    let s = connectionsEngine.init(ctx(['a', 'b'], ['j']), items, 0);
    s = connectionsEngine.act(s, pl('a'), { type: 'answer', text: 'alternative' }, 100);
    s = connectionsEngine.act(s, pl('b'), { type: 'answer', text: 'Link 0' }, 200);
    expect(s.phase).toBe('REVIEW');
    expect(connectionsEngine.nextDeadline(s)).toBeNull();
    expect(() => connectionsEngine.act(s, pl('a'), { type: 'review', memberId: 'a', accept: true }, 300)).toThrow(/Only a judge/);
    const jv = connectionsEngine.view(s, { memberId: 'j', role: 'JUDGE' }, 300) as any;
    expect(jv.reviews).toEqual([{ memberId: 'a', answer: 'alternative' }]);
    s = connectionsEngine.act(s, P('JUDGE', 'j'), { type: 'review', memberId: 'a', accept: true }, 5000);
    expect(s.phase).toBe('REVEAL');
    expect(connectionsEngine.scores(s)).toEqual({ a: '3', b: '2' });
    expect(connectionsEngine.gradedBy(s, 0, 'a')).toBe('j');
  });
});

describe('Championship tiebreak engine', () => {
  const items = Array.from({ length: 5 }, (_, i) => mcq(i));
  it('separates on first discriminating question and stops', () => {
    let s = tiebreakEngine.init(ctx(['a', 'b', 'c']), items, 0);
    s = tiebreakEngine.act(s, pl('a'), { type: 'answer', optionId: 'o1' }, 1);
    s = tiebreakEngine.act(s, pl('b'), { type: 'answer', optionId: 'o1' }, 2);
    s = tiebreakEngine.act(s, pl('c'), { type: 'answer', optionId: 'o2' }, 3);
    s = runTo(tiebreakEngine, s, s.phaseEnd!);
    expect(s.eligibleByItem[1]).toEqual(['a', 'b']);
    s = tiebreakEngine.act(s, pl('b'), { type: 'answer', optionId: 'o1' }, s.phaseStart + 1);
    s = runTo(tiebreakEngine, s, s.phaseStart + T.tiebreakQuestion + T.appealWindow);
    expect(tiebreakEngine.finished(s)).toBe(true);
    expect(tiebreakEngine.ranking(s)).toEqual([['b'], ['a'], ['c']]);
  });
  it('stays shared after five unresolved questions', () => {
    let s = tiebreakEngine.init(ctx(['a', 'b']), items, 0);
    s = runTo(tiebreakEngine, s, 1e9); // all time out (all wrong)
    expect(tiebreakEngine.finished(s)).toBe(true);
    expect(s.answers.length).toBe(5);
    expect(tiebreakEngine.ranking(s)).toEqual([['a', 'b']]);
  });
});
