import { Fraction } from '@ft/shared';
import { placementPositions, placementShares } from './placement.js';

export interface ModeOutcome {
  /** Final ranking groups of players who took part in the mode. */
  groups: string[][];
}

export interface StandingRow {
  memberId: string;
  points: Fraction;
  sole1: number;
  sole2: number;
  sole3: number;
}

/**
 * Championship standings (approved ladder steps 1–4): total placement points, then sole 1st,
 * sole 2nd and sole 3rd finishes. Tied placements do not count as sole finishes (blueprint G,
 * RECOMMENDED). Returns rows sorted and grouped; ties after step 4 stay grouped.
 */
export function computeStandings(
  participants: string[],
  outcomes: ModeOutcome[],
): { rows: StandingRow[]; groups: string[][] } {
  const rows = new Map<string, StandingRow>(
    participants.map((m) => [m, { memberId: m, points: Fraction.ZERO, sole1: 0, sole2: 0, sole3: 0 }]),
  );
  for (const o of outcomes) {
    const shares = placementShares(o.groups);
    const pos = placementPositions(o.groups);
    for (const [m, s] of Object.entries(shares)) {
      const r = rows.get(m);
      if (!r) continue;
      r.points = r.points.add(s);
      const p = pos[m]!;
      if (p.sole) {
        if (p.position === 0) r.sole1++;
        else if (p.position === 1) r.sole2++;
        else if (p.position === 2) r.sole3++;
      }
    }
  }
  const cmp = (a: StandingRow, b: StandingRow): number => {
    const c = b.points.cmp(a.points);
    if (c !== 0) return c;
    if (b.sole1 !== a.sole1) return b.sole1 - a.sole1;
    if (b.sole2 !== a.sole2) return b.sole2 - a.sole2;
    if (b.sole3 !== a.sole3) return b.sole3 - a.sole3;
    return 0;
  };
  const sorted = [...rows.values()].sort((a, b) => cmp(a, b) || (a.memberId < b.memberId ? -1 : 1));
  const groups: string[][] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && cmp(sorted[i - 1]!, sorted[i]!) === 0) groups[groups.length - 1]!.push(sorted[i]!.memberId);
    else groups.push([sorted[i]!.memberId]);
  }
  return { rows: sorted, groups };
}

export const MAX_TIEBREAK_QUESTIONS = 5;

/**
 * Ladder step 5: resolves a tie group for the championship using simultaneous tiebreak rounds.
 * Each round: correct outranks wrong among the still-tied contenders. If everyone in the
 * contending group answers the same (all correct or all wrong), nobody is separated
 * (PROPOSED: all-wrong rounds change nothing). After at most 5 rounds, remaining contenders
 * share the championship. Returns final ordered groups for the original tied set.
 */
export function resolveTiebreak(
  tied: string[],
  rounds: Array<Record<string, boolean>>,
): { groups: string[][]; done: boolean } {
  // Ordered list of groups; first group is contending for the title.
  let contenders = [...tied];
  const below: string[][] = []; // groups eliminated, most recently eliminated first
  let used = 0;
  for (const r of rounds) {
    if (used >= MAX_TIEBREAK_QUESTIONS || contenders.length <= 1) break;
    used++;
    const right = contenders.filter((m) => r[m] === true);
    const wrong = contenders.filter((m) => r[m] !== true);
    if (right.length > 0 && wrong.length > 0) {
      below.unshift(wrong);
      contenders = right;
    }
  }
  const done = contenders.length <= 1 || used >= MAX_TIEBREAK_QUESTIONS;
  return { groups: [contenders, ...below], done };
}
