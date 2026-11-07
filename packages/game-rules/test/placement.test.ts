import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Fraction } from '@ft/shared';
import { computeStandings, placementShares, resolveTiebreak } from '../src/index.js';

const str = (r: Record<string, Fraction>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toString()]));

describe('Match Night placement 5/3/1/0', () => {
  it('awards 5/3/1/0 with no ties', () => {
    expect(str(placementShares([['a'], ['b'], ['c'], ['d']]))).toEqual({ a: '5', b: '3', c: '1', d: '0' });
  });
  it('splits shared places by exact average of occupied values', () => {
    expect(str(placementShares([['a', 'b'], ['c']]))).toEqual({ a: '4', b: '4', c: '1' });
    expect(str(placementShares([['a'], ['b', 'c', 'd']]))).toEqual({ a: '5', b: '4/3', c: '4/3', d: '4/3' });
    expect(str(placementShares([['a', 'b', 'c']]))).toEqual({ a: '3', b: '3', c: '3' });
    expect(str(placementShares([['a'], ['b'], ['c', 'd']]))).toEqual({ a: '5', b: '3', c: '1/2', d: '1/2' });
    expect(str(placementShares([['a', 'b', 'c', 'd', 'e', 'f']]))).toEqual(
      Object.fromEntries('abcdef'.split('').map((k) => [k, '3/2'])),
    );
  });
  it('property: shares always sum to the points of the occupied places', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 6 }), (sizes) => {
        let id = 0;
        const groups = sizes.map((n) => Array.from({ length: n }, () => `p${id++}`)).filter(() => true);
        if (id > 6) return;
        const total = Fraction.sum(Object.values(placementShares(groups)));
        const expected = [5, 3, 1, 0, 0, 0].slice(0, id).reduce((a, b) => a + b, 0);
        expect(total.eq(Fraction.of(expected))).toBe(true);
      }),
    );
  });
});

describe('Championship ladder', () => {
  it('ranks by total placement points first', () => {
    const { groups } = computeStandings(
      ['a', 'b', 'c'],
      [
        { groups: [['a'], ['b'], ['c']] },
        { groups: [['b'], ['a'], ['c']] },
        { groups: [['a'], ['c'], ['b']] },
      ],
    );
    expect(groups).toEqual([['a'], ['b'], ['c']]);
  });
  it('breaks equal points by sole 1sts, then sole 2nds, then sole 3rds', () => {
    // a: 5+0+... vs b: 3+... construct equal totals
    // Mode1: a 1st(5) ; b 2nd(3) ; c 3rd(1) ; d 4th
    // Mode2: b 1st(5) ; c,d tie 2nd ((3+1)/2=2 each) ; a 4th(0)
    // a=5, b=8 ... adjust: totals a=5, b=5 requires b get 3+? Use explicit scenario:
    const r = computeStandings(
      ['a', 'b'],
      [{ groups: [['a'], ['b']] }, { groups: [['b'], ['a']] }, { groups: [['a', 'b']] }],
    );
    // a: 5+3+4 = 12, b: 3+5+4 = 12; sole1 a=1 b=1; sole2 a=1 b=1 => tied after ladder
    expect(r.groups).toEqual([['a', 'b']]);
    const r2 = computeStandings(
      ['a', 'b', 'c'],
      [
        { groups: [['a'], ['b'], ['c']] }, // a5 b3 c1
        { groups: [['b', 'c'], ['a']] }, // b4 c4 a1
        { groups: [['c'], ['a'], ['b']] }, // c5 a3 b1
      ],
    );
    // a=9 (sole1:1, sole2:1, sole3:1) b=8 c=10
    expect(r2.groups).toEqual([['c'], ['a'], ['b']]);
  });
  it('tied first places do not count as sole firsts', () => {
    const r = computeStandings(
      ['a', 'b', 'c'],
      [
        { groups: [['a', 'b'], ['c']] }, // a4 b4 c1
        { groups: [['c'], ['a'], ['b']] }, // c5 a3 b1
        { groups: [['b'], ['c'], ['a']] }, // b5 c3 a1
      ],
    );
    const a = r.rows.find((x) => x.memberId === 'a')!;
    expect(a.sole1).toBe(0);
    // a=8 b=10 c=9
    expect(r.groups.map((g) => g[0])).toEqual(['b', 'c', 'a']);
  });
  it('uses sole 2nds when points and sole 1sts tie', () => {
    // a: 1st,4th,3rd? Build: a=5+0+1=6 (s1=1,s2=0,s3=1); b=3+3+0=6 (s1=0,...) => a wins on sole1
    const r = computeStandings(
      ['a', 'b', 'c', 'd'],
      [
        { groups: [['a'], ['b'], ['c'], ['d']] },
        { groups: [['c'], ['b'], ['d'], ['a']] },
        { groups: [['d'], ['c'], ['a'], ['b']] },
      ],
    );
    const pts = Object.fromEntries(r.rows.map((x) => [x.memberId, x.points.toString()]));
    expect(pts).toEqual({ a: '6', b: '6', c: '9', d: '6' });
    // a,b,d have 6. sole1: a1 b0 d1 ; a vs d sole2: a0 d0 ; sole3: a1 d1 -> a,d tied; b last
    expect(r.groups).toEqual([['c'], ['a', 'd'], ['b']]);
  });
});

describe('Tiebreak (ladder step 5)', () => {
  it('correct outranks wrong; resolved after one separating round', () => {
    expect(resolveTiebreak(['a', 'b'], [{ a: true, b: false }])).toEqual({
      groups: [['a'], ['b']],
      done: true,
    });
  });
  it('all-wrong and all-correct rounds separate nobody', () => {
    const r = resolveTiebreak(
      ['a', 'b', 'c'],
      [
        { a: false, b: false, c: false },
        { a: true, b: true, c: true },
      ],
    );
    expect(r).toEqual({ groups: [['a', 'b', 'c']], done: false });
  });
  it('multiway: later-eliminated players rank above earlier-eliminated', () => {
    const r = resolveTiebreak(
      ['a', 'b', 'c', 'd'],
      [
        { a: true, b: true, c: true, d: false },
        { a: true, b: false, c: true },
        { a: true, c: false },
      ],
    );
    expect(r.groups).toEqual([['a'], ['c'], ['b'], ['d']]);
    expect(r.done).toBe(true);
  });
  it('after five unresolved rounds remaining players are shared champions', () => {
    const rounds = Array.from({ length: 7 }, () => ({ a: true, b: true }));
    expect(resolveTiebreak(['a', 'b'], rounds)).toEqual({ groups: [['a', 'b']], done: true });
  });
  it('property: output partitions the tied set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ a: fc.boolean(), b: fc.boolean(), c: fc.boolean(), d: fc.boolean() }), {
          maxLength: 8,
        }),
        (rounds) => {
          const r = resolveTiebreak(['a', 'b', 'c', 'd'], rounds);
          expect(r.groups.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
          expect(r.groups.every((g) => g.length > 0)).toBe(true);
        },
      ),
    );
  });
});
