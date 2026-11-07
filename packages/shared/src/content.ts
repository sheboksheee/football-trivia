/**
 * Published, pinned content items consumed by game engines. Produced only by the content
 * pipeline (services/content) after every publication gate passed. Items contain answers and
 * therefore live server-side only; clients receive engine projections, never raw items.
 */

export interface ItemMeta {
  questionId: string;
  version: number;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'EXPERT';
  difficultyStatus: 'PROVISIONAL' | 'CALIBRATED';
  /** Public attribution shown at reveal, e.g. "Synthetic Dev League dataset (fictional)". */
  attribution: string;
  sourceIds: string[];
  evidenceIds: string[];
}

export interface McqItem {
  kind: 'mcq';
  meta: ItemMeta;
  prompt: string;
  options: { id: string; label: string }[];
  correctOptionId: string;
  explanation: string;
}

export interface HigherLowerItem {
  kind: 'higher_lower';
  meta: ItemMeta;
  statLabel: string;
  scope: string;
  a: { label: string; value: number };
  b: { label: string; value: number };
  unit: string;
}

export interface ShortAnswerItem {
  kind: 'short_answer';
  meta: ItemMeta;
  prompt: string;
  answer: string;
  aliases: string[];
  explanation: string;
}

export interface ConnectionItem {
  kind: 'connection';
  meta: ItemMeta;
  entities: string[];
  link: string;
  aliases: string[];
  explanation: string;
}

export interface TimelineItem {
  kind: 'timeline';
  meta: ItemMeta;
  prompt: string;
  events: { id: string; label: string; date: string }[];
  earlierId: string;
}

export interface ImpostorItem {
  kind: 'impostor';
  meta: ItemMeta;
  footballer: string;
  aliases: string[];
  context: string;
}

export interface MissingXiItem {
  kind: 'missing_xi';
  meta: ItemMeta;
  match: string;
  date: string;
  team: string;
  formation: string;
  slots: { slot: number; position: string; player: string | null }[];
  missingAnswer: string;
  aliases: string[];
  hints: [string, string];
}

export interface GuessMatchItem {
  kind: 'guess_match';
  meta: ItemMeta;
  options: { id: string; label: string }[];
  correctOptionId: string;
  clues: [string, string, string];
}

export interface Top25Item {
  kind: 'top25';
  meta: ItemMeta;
  title: string;
  scope: string;
  entries: { rank: number; label: string; aliases: string[]; metric: string }[];
}

export interface AuctionItem {
  kind: 'auction';
  meta: ItemMeta;
  category: string;
  scope: string;
  universe: { label: string; aliases: string[] }[];
}

export type ContentItem =
  | McqItem
  | HigherLowerItem
  | ShortAnswerItem
  | ConnectionItem
  | TimelineItem
  | ImpostorItem
  | MissingXiItem
  | GuessMatchItem
  | Top25Item
  | AuctionItem;

export type ContentKind = ContentItem['kind'];
