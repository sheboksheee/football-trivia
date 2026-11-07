import type { McqItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimState } from '../simultaneous.js';
import { MAX_TIEBREAK_QUESTIONS, resolveTiebreak } from '../ladder.js';
import { parseMcq, viewMcq, type McqAnswer } from './lastManStanding.js';

type S = SimState<McqItem, McqAnswer, null>;

function rounds(s: S, upTo: number): Array<Record<string, boolean>> {
  const out: Array<Record<string, boolean>> = [];
  for (let i = 0; i < upTo; i++) {
    if (s.voided.includes(i)) continue;
    const item = s.items[i]!;
    const r: Record<string, boolean> = {};
    for (const m of s.eligibleByItem[i] ?? []) {
      r[m] = s.regraded.includes(`${i}:${m}`) || s.answers[i]?.[m]?.optionId === item.correctOptionId;
    }
    out.push(r);
  }
  return out;
}

/** Ladder step 5: up to five simultaneous 15s four-option questions, no speed bonus. */
export const tiebreakEngine = makeSimultaneousEngine<McqItem, McqAnswer, null>({
  key: 'tiebreak',
  contentKind: 'mcq',
  itemsNeeded: () => MAX_TIEBREAK_QUESTIONS,
  questionMs: (t) => t.tiebreakQuestion,
  initExtra: () => null,
  eligible: (s) => resolveTiebreak(s.players, rounds(s, Math.max(0, s.index))).groups[0]!,
  parseAnswer: (_s, item, _m, action, now) => parseMcq(item, action, now),
  grade: (item, ans) => ans !== undefined && ans.optionId === item.correctOptionId,
  shouldEnd: (s) => resolveTiebreak(s.players, rounds(s, s.index + 1)).groups[0]!.length <= 1,
  scores: (s) => Object.fromEntries(s.players.map((m) => [m, '0'])),
  ranking: (s) => resolveTiebreak(s.players, rounds(s, s.phase === 'DONE' ? s.items.length : s.index)).groups,
  viewItem: (_s, item, revealed) => viewMcq(item, revealed),
  viewAnswer: (a) => a.optionId,
});
