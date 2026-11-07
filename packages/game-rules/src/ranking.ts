import { Fraction } from '@ft/shared';

/** Groups players by score (desc). Equal scores form one tied group. Input order breaks nothing. */
export function groupByScore(scores: Record<string, string>, players: string[]): string[][] {
  const sorted = [...players].sort((a, b) => {
    const c = Fraction.parse(scores[b] ?? '0').cmp(Fraction.parse(scores[a] ?? '0'));
    return c !== 0 ? c : a < b ? -1 : a > b ? 1 : 0;
  });
  const groups: string[][] = [];
  let prev: Fraction | null = null;
  for (const p of sorted) {
    const v = Fraction.parse(scores[p] ?? '0');
    if (prev && prev.eq(v)) groups[groups.length - 1]!.push(p);
    else groups.push([p]);
    prev = v;
  }
  return groups;
}

export function toFractionRecord(r: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
}

export function zeroScores(players: string[]): Record<string, number> {
  return Object.fromEntries(players.map((p) => [p, 0]));
}
