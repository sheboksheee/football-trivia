import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Fraction } from '../src/index.js';

describe('Fraction', () => {
  it('normalizes and formats', () => {
    expect(Fraction.of(8, 2).toString()).toBe('4');
    expect(Fraction.of(4, 3).toString()).toBe('4/3');
    expect(Fraction.of(-2, -4).toString()).toBe('1/2');
    expect(Fraction.of(1, -2).toString()).toBe('-1/2');
    expect(Fraction.of(4, 3).toMixed()).toBe('1 1/3');
    expect(Fraction.of(4, 3).toDisplay()).toBe('1.33');
    expect(Fraction.of(9, 4).toDisplay()).toBe('2.25');
  });
  it('rejects zero denominators and non-integers', () => {
    expect(() => Fraction.of(1, 0)).toThrow();
    expect(() => Fraction.of(0.5)).toThrow();
  });
  it('round-trips through parse', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: 1, max: 1e6 }), (n, d) => {
        const f = Fraction.of(n, d);
        expect(Fraction.parse(f.toString()).eq(f)).toBe(true);
      }),
    );
  });
  it('sums exactly: 1/3 * 3 = 1 (no float drift)', () => {
    const third = Fraction.of(1, 3);
    expect(Fraction.sum([third, third, third]).toString()).toBe('1');
  });
  it('arithmetic is consistent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (a, b, c, d) => {
          const x = Fraction.of(a, b);
          const y = Fraction.of(c, d);
          expect(x.add(y).sub(y).eq(x)).toBe(true);
          if (c !== 0) expect(x.mul(y).div(y).eq(x)).toBe(true);
          expect(x.cmp(y)).toBe(-y.cmp(x) as -1 | 0 | 1);
        },
      ),
    );
  });
});
