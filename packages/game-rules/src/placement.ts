import { Fraction } from '@ft/shared';

/** Approved Match Night placement values: 1st 5, 2nd 3, 3rd 1, 4th+ 0. */
export const PLACEMENT_POINTS = [5, 3, 1] as const;

export function pointsForPosition(pos: number): number {
  return PLACEMENT_POINTS[pos] ?? 0;
}

/**
 * Converts a mode's final ranking groups into placement shares. A tie group occupying
 * positions i..j receives sum(points[i..j]) / groupSize each, as an exact fraction.
 */
export function placementShares(groups: string[][]): Record<string, Fraction> {
  const out: Record<string, Fraction> = {};
  let pos = 0;
  for (const g of groups) {
    let total = 0;
    for (let k = 0; k < g.length; k++) total += pointsForPosition(pos + k);
    const share = Fraction.of(total, g.length);
    for (const m of g) out[m] = share;
    pos += g.length;
  }
  return out;
}

/** Positions (0-based) each player occupied, plus whether they were sole occupant. */
export function placementPositions(groups: string[][]): Record<string, { position: number; sole: boolean }> {
  const out: Record<string, { position: number; sole: boolean }> = {};
  let pos = 0;
  for (const g of groups) {
    for (const m of g) out[m] = { position: pos, sole: g.length === 1 };
    pos += g.length;
  }
  return out;
}
