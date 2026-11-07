/* Test-only synthetic items. Entities are fictional; no real football facts. */
import type {
  AuctionItem,
  ConnectionItem,
  GuessMatchItem,
  HigherLowerItem,
  ImpostorItem,
  ItemMeta,
  McqItem,
  MissingXiItem,
  ShortAnswerItem,
  TimelineItem,
  Top25Item,
} from '@ft/shared';
import { DEFAULT_TIMING, type Engine, type EngineCtx } from '../src/index.js';

export const meta = (id: string): ItemMeta => ({
  questionId: id,
  version: 1,
  difficulty: 'MEDIUM',
  difficultyStatus: 'PROVISIONAL',
  attribution: 'Test fixture (fictional)',
  sourceIds: ['src_test'],
  evidenceIds: ['ev_' + id],
});

export const hl = (i: number, a: number, b: number): HigherLowerItem => ({
  kind: 'higher_lower',
  meta: meta(`hl${i}`),
  statLabel: 'Goals',
  scope: 'Test League 2001',
  unit: 'goals',
  a: { label: `Player A${i}`, value: a },
  b: { label: `Player B${i}`, value: b },
});
export const mcq = (i: number, correct = 'o1'): McqItem => ({
  kind: 'mcq',
  meta: meta(`mcq${i}`),
  prompt: `Q${i}?`,
  options: ['o1', 'o2', 'o3', 'o4'].map((id) => ({ id, label: id.toUpperCase() })),
  correctOptionId: correct,
  explanation: 'x',
});
export const shortA = (i: number): ShortAnswerItem => ({
  kind: 'short_answer',
  meta: meta(`sa${i}`),
  prompt: `Who ${i}?`,
  answer: `Answer ${i}`,
  aliases: [`Ans${i}`],
  explanation: 'x',
});
export const conn = (i: number): ConnectionItem => ({
  kind: 'connection',
  meta: meta(`cn${i}`),
  entities: ['A', 'B', 'C', 'D'],
  link: `Link ${i}`,
  aliases: [`L${i}`],
  explanation: 'x',
});
export const tl = (i: number): TimelineItem => ({
  kind: 'timeline',
  meta: meta(`tl${i}`),
  prompt: 'Which came first?',
  events: [
    { id: 'e1', label: 'Early', date: '2001-01-01' },
    { id: 'e2', label: 'Late', date: '2005-01-01' },
  ],
  earlierId: 'e1',
});
export const imp = (i: number): ImpostorItem => ({
  kind: 'impostor',
  meta: meta(`im${i}`),
  footballer: `Star ${i}`,
  aliases: [`S${i}`],
  context: 'Fictional forward',
});
export const xi = (i: number): MissingXiItem => ({
  kind: 'missing_xi',
  meta: meta(`xi${i}`),
  match: 'Northbridge v Eastvale',
  date: '2003-05-01',
  team: 'Northbridge',
  formation: '4-4-2',
  slots: Array.from({ length: 11 }, (_, k) => ({
    slot: k,
    position: k === 0 ? 'GK' : 'MF',
    player: k === 5 ? null : `P${k}`,
  })),
  missingAnswer: `Missing ${i}`,
  aliases: [`M${i}`],
  hints: ['Shirt 8', 'Midfielder'],
});
export const gm = (i: number): GuessMatchItem => ({
  kind: 'guess_match',
  meta: meta(`gm${i}`),
  options: ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, label: id })),
  correctOptionId: 'm2',
  clues: ['c1', 'c2', 'c3'],
});
export const top25 = (): Top25Item => ({
  kind: 'top25',
  meta: meta('t25'),
  title: 'Top scorers',
  scope: 'Test League all-time',
  entries: Array.from({ length: 25 }, (_, k) => ({
    rank: k + 1,
    label: `Name ${k + 1}`,
    aliases: [],
    metric: `${100 - k} goals`,
  })),
});
export const auction = (i: number, size = 10): AuctionItem => ({
  kind: 'auction',
  meta: meta(`au${i}`),
  category: `Category ${i}`,
  scope: 'Test',
  universe: Array.from({ length: size }, (_, k) => ({ label: `U${k}`, aliases: [] })),
});

export function ctx(players: string[], judges: string[] = [], seed = 1): EngineCtx {
  return { players, judges, seed, timing: DEFAULT_TIMING };
}

/** Steps an engine through all deadlines up to time `t`. */
export function runTo<S>(e: Engine<S>, s: S, t: number): S {
  for (let g = 0; g < 10000; g++) {
    const d = e.nextDeadline(s);
    if (d === null || d > t) return s;
    s = e.step(s, d);
  }
  throw new Error('loop');
}

export const P = (role: 'PLAYER' | 'JUDGE' | 'SPECTATOR', memberId: string) => ({ role, memberId });
