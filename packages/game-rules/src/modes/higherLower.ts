import { GameError, type HigherLowerItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimAnswer } from '../simultaneous.js';

export interface HlAnswer extends SimAnswer {
  choice: 'HIGHER' | 'LOWER';
}

export function correctChoice(item: HigherLowerItem): 'HIGHER' | 'LOWER' {
  if (item.a.value === item.b.value)
    throw new Error('Higher or Lower item has equal values (validator should reject)');
  return item.b.value > item.a.value ? 'HIGHER' : 'LOWER';
}

/**
 * APPROVED scoring: +2 per correct; +1 for each fully-correct non-overlapping pair (1,2) and (3,4);
 * +3 for a perfect 5/5. Maximum 15. A voided comparison scores nothing for anyone and cannot
 * complete a pair or perfect (applies equally to all players).
 */
export function higherLowerScore(correct: Array<boolean | null>): number {
  const c = (i: number) => correct[i] === true;
  let s = 0;
  for (let i = 0; i < 5; i++) if (c(i)) s += 2;
  if (c(0) && c(1)) s += 1;
  if (c(2) && c(3)) s += 1;
  if ([0, 1, 2, 3, 4].every(c)) s += 3;
  return s;
}

export const higherLowerEngine = makeSimultaneousEngine<HigherLowerItem, HlAnswer, null>({
  key: 'higher_lower',
  contentKind: 'higher_lower',
  itemsNeeded: () => 5,
  questionMs: (t) => t.higherLowerQuestion,
  initExtra: () => null,
  parseAnswer(_s, _item, _m, action, now) {
    if (action.choice !== 'HIGHER' && action.choice !== 'LOWER')
      throw new GameError('INVALID_MESSAGE', 'choice must be HIGHER or LOWER');
    return { at: now, choice: action.choice };
  },
  grade: (item, ans) => ans !== undefined && ans.choice === correctChoice(item),
  scores(s, correct) {
    return Object.fromEntries(
      s.players.map((m) => [m, String(higherLowerScore(s.items.map((_, i) => correct(i, m))))]),
    );
  },
  viewItem(_s, item, revealed) {
    return {
      statLabel: item.statLabel,
      scope: item.scope,
      unit: item.unit,
      a: item.a,
      b: { label: item.b.label, value: revealed ? item.b.value : null },
      correct: revealed ? correctChoice(item) : null,
      attribution: revealed ? item.meta.attribution : null,
    };
  },
  viewAnswer: (a) => a.choice,
});
