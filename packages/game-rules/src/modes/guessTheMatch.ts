import { GameError, type GuessMatchItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimAnswer, type SimState } from '../simultaneous.js';

export interface GmAnswer extends SimAnswer {
  optionId: string;
  tier: number;
}
type S = SimState<GuessMatchItem, GmAnswer, null>;

/** APPROVED: confirmed with 1 clue visible +5, 2 clues +3, 3 clues +1; wrong 0; no speed bonus. */
export const GM_POINTS = [5, 3, 1] as const;

export function visibleClues(s: S, now: number): number {
  const elapsed = now - s.phaseStart;
  return s.timing.guessMatchClues.filter((t) => elapsed >= t).length;
}

export const guessTheMatchEngine = makeSimultaneousEngine<GuessMatchItem, GmAnswer, null>({
  key: 'guess_the_match',
  contentKind: 'guess_match',
  itemsNeeded: () => 8,
  questionMs: (t) => t.guessMatchQuestion,
  initExtra: () => null,
  milestones: (s) => s.timing.guessMatchClues.map((t) => s.phaseStart + t),
  parseAnswer(s, item, _m, action, now) {
    const id = action.optionId;
    if (typeof id !== 'string' || !item.options.some((o) => o.id === id))
      throw new GameError('INVALID_MESSAGE', 'Unknown option');
    return { at: now, optionId: id, tier: Math.max(1, visibleClues(s, now)) };
  },
  grade: (item, ans) => ans !== undefined && ans.optionId === item.correctOptionId,
  scores(s, correct) {
    return Object.fromEntries(
      s.players.map((m) => {
        let total = 0;
        s.items.forEach((_, i) => {
          if (correct(i, m) === true) total += GM_POINTS[(s.answers[i]?.[m]?.tier ?? 3) - 1] ?? 0;
        });
        return [m, String(total)];
      }),
    );
  },
  viewItem(s, item, revealed, _viewer, now) {
    const n = revealed ? 3 : visibleClues(s, now);
    return {
      options: item.options,
      clues: item.clues.slice(0, n),
      clueTimes: s.timing.guessMatchClues,
      correctOptionId: revealed ? item.correctOptionId : null,
      attribution: revealed ? item.meta.attribution : null,
    };
  },
  viewAnswer: (a) => ({ optionId: a.optionId, tier: a.tier }),
});
