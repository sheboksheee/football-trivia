/**
 * Exact rational numbers backed by BigInt. Used for Match Night placement shares
 * (e.g. two players tied for 1st each receive (5+3)/2 = 4, three tied for 2nd receive 4/3).
 * Never use binary floating point for championship points.
 */
export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    if (den === 0n) throw new RangeError('Fraction denominator cannot be zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num < 0n ? -num : num, den);
    this.num = num / g;
    this.den = den / g;
  }

  static of(num: number | bigint, den: number | bigint = 1): Fraction {
    const n = typeof num === 'number' ? toBigInt(num) : num;
    const d = typeof den === 'number' ? toBigInt(den) : den;
    return new Fraction(n, d);
  }

  static readonly ZERO = new Fraction(0n, 1n);

  static parse(s: string): Fraction {
    const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s.trim());
    if (!m) throw new RangeError(`Invalid fraction: ${s}`);
    return new Fraction(BigInt(m[1]!), BigInt(m[2] ?? '1'));
  }

  add(o: Fraction): Fraction {
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Fraction): Fraction {
    return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Fraction): Fraction {
    return new Fraction(this.num * o.num, this.den * o.den);
  }
  div(o: Fraction): Fraction {
    return new Fraction(this.num * o.den, this.den * o.num);
  }
  cmp(o: Fraction): -1 | 0 | 1 {
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o: Fraction): boolean {
    return this.cmp(o) === 0;
  }
  /** Canonical string form: "4", "4/3", "-1/2". Lossless; use for storage and wire. */
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
  toJSON(): string {
    return this.toString();
  }
  /** Display-only approximation. Never use for comparisons. */
  toDisplay(decimals = 2): string {
    if (this.den === 1n) return this.num.toString();
    const scale = 10n ** BigInt(decimals);
    const neg = this.num < 0n;
    const abs = neg ? -this.num : this.num;
    const scaled = (abs * scale * 2n + this.den) / (this.den * 2n); // round half up
    const int = scaled / scale;
    const frac = (scaled % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
  }
  /** Mixed-number display, e.g. "1 1/3". */
  toMixed(): string {
    if (this.den === 1n) return this.num.toString();
    const neg = this.num < 0n;
    const abs = neg ? -this.num : this.num;
    const whole = abs / this.den;
    const rem = abs % this.den;
    return `${neg ? '-' : ''}${whole > 0n ? `${whole} ` : ''}${rem}/${this.den}`;
  }

  static sum(values: Iterable<Fraction>): Fraction {
    let acc = Fraction.ZERO;
    for (const v of values) acc = acc.add(v);
    return acc;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function toBigInt(n: number): bigint {
  if (!Number.isInteger(n)) throw new RangeError(`Fraction parts must be integers, got ${n}`);
  return BigInt(n);
}
