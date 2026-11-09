import { GameError, matchesAlias, type WhoAmIItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimAnswer, type SimState } from '../simultaneous.js';

export interface WaiAnswer extends SimAnswer {
  text: string;
  tier: number;
}
type S = SimState<WhoAmIItem, WaiAnswer, null>;

/**
 * PROPOSED (owner delegated the rules, 2026-11-09): 5 clues revealed every 8s; one typed answer per
 * player, locked at submission; correct after k visible clues = 6 − k points (+5 … +1); wrong 0, no
 * lockout penalty; no speed bonus; equal totals share the place (P-X6).
 */
export const WAI_POINTS = [5, 4, 3, 2, 1] as const;

export function whoAmIVisibleClues(s: S, now: number): number {
  const elapsed = now - s.phaseStart;
  return s.timing.whoAmIClues.filter((t) => elapsed >= t).length;
}

export const whoAmIEngine = makeSimultaneousEngine<WhoAmIItem, WaiAnswer, null>({
  key: 'who_am_i',
  contentKind: 'who_am_i',
  itemsNeeded: () => 6,
  questionMs: (t) => t.whoAmIQuestion,
  initExtra: () => null,
  milestones: (s) => s.timing.whoAmIClues.map((t) => s.phaseStart + t),
  parseAnswer(s, _item, _m, action, now) {
    const text = typeof action.text === 'string' ? action.text.trim() : '';
    if (!text || text.length > 80) throw new GameError('INVALID_MESSAGE', 'Answer must be 1–80 characters');
    return { at: now, text, tier: Math.max(1, whoAmIVisibleClues(s, now)) };
  },
  grade: (item, ans) =>
    ans !== undefined && matchesAlias(ans.text, [item.answer, ...item.aliases], item.rivals),
  scores(s, correct) {
    return Object.fromEntries(
      s.players.map((m) => {
        let total = 0;
        s.items.forEach((_, i) => {
          if (correct(i, m) === true) total += WAI_POINTS[(s.answers[i]?.[m]?.tier ?? 5) - 1] ?? 0;
        });
        return [m, String(total)];
      }),
    );
  },
  viewItem(s, item, revealed, _viewer, now) {
    const n = revealed ? item.clues.length : whoAmIVisibleClues(s, now);
    return {
      clues: item.clues.slice(0, n),
      clueTimes: s.timing.whoAmIClues,
      answer: revealed ? item.answer : null,
      attribution: revealed ? item.meta.attribution : null,
    };
  },
  viewAnswer: (a) => ({ text: a.text, tier: a.tier }),
});
