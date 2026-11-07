import { GameError, matchesAlias, type ConnectionItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimAnswer, type SimState } from '../simultaneous.js';

export interface ConnAnswer extends SimAnswer {
  text: string;
  seq: number;
}
type S = SimState<ConnectionItem, ConnAnswer, null>;

/**
 * APPROVED: earliest valid correct +3, other correct +2. Ordering uses server receipt
 * (timestamp, then receipt sequence) of the submission — not grading time.
 */
export function connectionsItemPoints(
  s: S,
  i: number,
  correct: (i: number, m: string) => boolean | null,
): Record<string, number> {
  const ans = s.answers[i] ?? {};
  const right = Object.entries(ans)
    .filter(([m]) => correct(i, m) === true)
    .sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq);
  const out: Record<string, number> = {};
  right.forEach(([m], k) => (out[m] = k === 0 ? 3 : 2));
  return out;
}

export const connectionsEngine = makeSimultaneousEngine<ConnectionItem, ConnAnswer, null>({
  key: 'connections',
  contentKind: 'connection',
  itemsNeeded: () => 8,
  questionMs: (t) => t.connectionsQuestion,
  initExtra: () => null,
  parseAnswer(s, _item, _m, action, now) {
    const text = typeof action.text === 'string' ? action.text.trim() : '';
    if (!text || text.length > 80) throw new GameError('INVALID_MESSAGE', 'Answer must be 1–80 characters');
    return { at: now, text, seq: Object.keys(s.answers[s.index] ?? {}).length };
  },
  grade: (item, ans) =>
    ans === undefined ? false : matchesAlias(ans.text, [item.link, ...item.aliases]) ? true : 'review',
  scores(s, correct) {
    const totals: Record<string, number> = Object.fromEntries(s.players.map((p) => [p, 0]));
    s.items.forEach((_, i) => {
      for (const [m, p] of Object.entries(connectionsItemPoints(s, i, correct)))
        totals[m] = (totals[m] ?? 0) + p;
    });
    return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, String(v)]));
  },
  viewItem(_s, item, revealed) {
    return {
      entities: item.entities,
      link: revealed ? item.link : null,
      explanation: revealed ? item.explanation : null,
      attribution: revealed ? item.meta.attribution : null,
    };
  },
  viewAnswer: (a) => a.text,
});
