import { GameError, matchesAlias, type MissingXiItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimAnswer, type SimState } from '../simultaneous.js';

export interface XiAnswer extends SimAnswer {
  text: string;
  hintsViewed: number;
}
interface XiExtra {
  /** `${itemIndex}:${memberId}` -> hints viewed (0..2) */
  hints: Record<string, number>;
}
type S = SimState<MissingXiItem, XiAnswer, XiExtra>;

/** APPROVED: +5 with no hints, +3 after one hint, +1 after both hints; wrong 0. */
export const XI_POINTS = [5, 3, 1] as const;

export const missingXiEngine = makeSimultaneousEngine<MissingXiItem, XiAnswer, XiExtra>({
  key: 'missing_xi',
  contentKind: 'missing_xi',
  itemsNeeded: () => 10,
  questionMs: (t) => t.missingXiQuestion,
  initExtra: () => ({ hints: {} }),
  extraAction(s: S, memberId, action, now) {
    if (action.type !== 'hint') throw new GameError('INVALID_MESSAGE', 'Unknown action');
    if (s.answers[s.index]?.[memberId]) throw new GameError('INVALID_STATE', 'Answer already locked in');
    const key = `${s.index}:${memberId}`;
    const viewed = s.extra.hints[key] ?? 0;
    if (viewed >= 2) throw new GameError('INVALID_STATE', 'No more hints');
    const availableAt = s.phaseStart + s.timing.missingXiHints[viewed]!;
    if (now < availableAt) throw new GameError('RULE_VIOLATION', 'Hint not available yet');
    return { ...s, extra: { hints: { ...s.extra.hints, [key]: viewed + 1 } } };
  },
  parseAnswer(s, _item, memberId, action, now) {
    const text = typeof action.text === 'string' ? action.text.trim() : '';
    if (!text || text.length > 80) throw new GameError('INVALID_MESSAGE', 'Answer must be 1–80 characters');
    return { at: now, text, hintsViewed: s.extra.hints[`${s.index}:${memberId}`] ?? 0 };
  },
  // Typos are tolerated unless the answer is as close to another player in the same lineup.
  grade: (item, ans) =>
    ans !== undefined &&
    matchesAlias(
      ans.text,
      [item.missingAnswer, ...item.aliases],
      item.slots.map((s) => s.player).filter((p): p is string => !!p),
    ),
  scores(s, correct) {
    return Object.fromEntries(
      s.players.map((m) => {
        let total = 0;
        s.items.forEach((_, i) => {
          if (correct(i, m) === true) total += XI_POINTS[s.answers[i]?.[m]?.hintsViewed ?? 0] ?? 0;
        });
        return [m, String(total)];
      }),
    );
  },
  viewItem(s, item, revealed, viewer) {
    const viewed = viewer.memberId ? (s.extra.hints[`${s.items.indexOf(item)}:${viewer.memberId}`] ?? 0) : 0;
    return {
      match: item.match,
      date: item.date,
      team: item.team,
      formation: item.formation,
      slots: item.slots,
      hintTimes: s.timing.missingXiHints,
      hintsViewed: viewed,
      hints: revealed ? item.hints : item.hints.slice(0, viewed),
      answer: revealed ? item.missingAnswer : null,
      attribution: revealed ? item.meta.attribution : null,
    };
  },
  viewAnswer: (a) => ({ text: a.text, hintsViewed: a.hintsViewed }),
});
