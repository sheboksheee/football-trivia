import { Fraction, GameError, type McqItem } from '@ft/shared';
import { makeSimultaneousEngine, type SimAnswer, type SimState } from '../simultaneous.js';
import { placementShares } from '../placement.js';

export interface McqAnswer extends SimAnswer {
  optionId: string;
}

export const LMS_HEARTS = 3;
export const LMS_MAX_QUESTIONS = 15;

interface LmsExtra {
  public: { hearts: Record<string, number>; eliminatedAt: Record<string, number> };
}
type S = SimState<McqItem, McqAnswer, LmsExtra>;

export function parseMcq(item: McqItem, action: Record<string, unknown>, now: number): McqAnswer {
  const id = action.optionId;
  if (typeof id !== 'string' || !item.options.some((o) => o.id === id)) throw new GameError('INVALID_MESSAGE', 'Unknown option');
  return { at: now, optionId: id };
}

export function viewMcq(item: McqItem, revealed: boolean) {
  return {
    prompt: item.prompt,
    options: item.options,
    correctOptionId: revealed ? item.correctOptionId : null,
    explanation: revealed ? item.explanation : null,
    attribution: revealed ? item.meta.attribution : null,
  };
}

/**
 * PROPOSED ordering (GDD open issue): alive before eliminated, then more hearts, then later
 * elimination. Equal keys share a place. Native score = averaged placement share (5/3/1/0),
 * plus +1 perfect survival (alive with all hearts).
 */
export function lmsRankingGroups(players: string[], hearts: Record<string, number>, eliminatedAt: Record<string, number>): string[][] {
  const key = (m: string) => [hearts[m]! > 0 ? 1 : 0, hearts[m]!, eliminatedAt[m] ?? Number.MAX_SAFE_INTEGER] as const;
  const cmp = (a: string, b: string) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
    return 0;
  };
  const sorted = [...players].sort((a, b) => cmp(a, b) || (a < b ? -1 : 1));
  const groups: string[][] = [];
  sorted.forEach((m, i) => {
    if (i > 0 && cmp(sorted[i - 1]!, m) === 0) groups[groups.length - 1]!.push(m);
    else groups.push([m]);
  });
  return groups;
}

function lmsScores(s: S): Record<string, string> {
  const { hearts, eliminatedAt } = s.extra.public;
  const shares = placementShares(lmsRankingGroups(s.players, hearts, eliminatedAt));
  return Object.fromEntries(
    s.players.map((m) => {
      const bonus = s.phase === 'DONE' && hearts[m] === LMS_HEARTS ? 1 : 0;
      const base = s.phase === 'DONE' ? shares[m]! : Fraction.ZERO;
      return [m, base.add(Fraction.of(bonus)).toString()];
    }),
  );
}

export const lastManStandingEngine = makeSimultaneousEngine<McqItem, McqAnswer, LmsExtra>({
  key: 'last_man_standing',
  contentKind: 'mcq',
  itemsNeeded: () => LMS_MAX_QUESTIONS,
  questionMs: (t) => t.lmsQuestion,
  initExtra: (ctx) => ({
    public: { hearts: Object.fromEntries(ctx.players.map((p) => [p, LMS_HEARTS])), eliminatedAt: {} },
  }),
  eligible: (s) => s.players.filter((m) => s.extra.public.hearts[m]! > 0),
  parseAnswer: (_s, item, _m, action, now) => parseMcq(item, action, now),
  grade: (item, ans) => ans !== undefined && ans.optionId === item.correctOptionId,
  onItemSettled(s, correct) {
    const hearts = { ...s.extra.public.hearts };
    const eliminatedAt = { ...s.extra.public.eliminatedAt };
    for (const m of s.eligibleByItem[s.index] ?? []) {
      if (correct(s.index, m) === false) {
        hearts[m] = Math.max(0, hearts[m]! - 1);
        if (hearts[m] === 0) eliminatedAt[m] = s.index;
      }
    }
    return { ...s, extra: { public: { hearts, eliminatedAt } } };
  },
  shouldEnd: (s) => s.players.filter((m) => s.extra.public.hearts[m]! > 0).length <= 1,
  scores: (s) => lmsScores(s),
  ranking: (s) => lmsRankingGroups(s.players, s.extra.public.hearts, s.extra.public.eliminatedAt),
  viewItem: (_s, item, revealed) => viewMcq(item, revealed),
  viewAnswer: (a) => a.optionId,
});
