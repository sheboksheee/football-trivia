import type { AppealDecision, ContentItem, ContentKind, RoomRole } from '@ft/shared';
import type { Timing } from './timing.js';

export interface Viewer {
  memberId: string | null;
  role: RoomRole;
}

export interface Actor {
  memberId: string;
  role: RoomRole;
}

export interface EngineCtx {
  players: string[];
  judges: string[];
  seed: number;
  timing: Timing;
}

export interface AppealWindow {
  itemIndex: number;
  /** game-time ms when the window closes */
  closesAt: number;
  /** players allowed to appeal this item */
  eligible: string[];
}

export interface Adjudication {
  itemIndex: number;
  claimantId: string;
  decision: AppealDecision;
  /** Mode-specific detail, e.g. TOP 25 rank confirmed by the judge. */
  detail?: number;
}

/**
 * A deterministic, pure mode engine. All times are game-time (pauses/holds excluded).
 * - `step` processes exactly one deadline; it must use the deadline (not wall-clock) as "now"
 *   so replays are identical regardless of when timers physically fire.
 * - `view` must never leak hidden answers, roles or votes to unauthorised viewers.
 */
export interface Engine<S = unknown, I extends ContentItem = ContentItem> {
  key: string;
  contentKind: ContentKind;
  itemsNeeded(playerCount: number): number;
  init(ctx: EngineCtx, items: I[], now: number): S;
  act(s: S, actor: Actor, action: Record<string, unknown>, now: number): S;
  step(s: S, deadline: number): S;
  nextDeadline(s: S): number | null;
  finished(s: S): boolean;
  /** True between questions: host pause may take effect. */
  atBoundary(s: S): boolean;
  /** Native mode scores as exact fraction strings. */
  scores(s: S): Record<string, string>;
  /** Final ranking groups, best first; members of a group are tied. */
  ranking(s: S): string[][];
  appealWindows(s: S, now: number): AppealWindow[];
  adjudicate(s: S, adj: Adjudication): S;
  /** Judge who graded the item (conflict-of-interest check), if any. */
  gradedBy(s: S, itemIndex: number, claimantId: string): string | null;
  supportedDecisions: AppealDecision[];
  view(s: S, viewer: Viewer, now: number): unknown;
}
