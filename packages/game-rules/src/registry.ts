import type { ModeKey } from '@ft/shared';
import type { Engine } from './types.js';
import { higherLowerEngine } from './modes/higherLower.js';
import { lastManStandingEngine } from './modes/lastManStanding.js';
import { missingXiEngine } from './modes/missingXi.js';
import { guessTheMatchEngine } from './modes/guessTheMatch.js';
import { connectionsEngine } from './modes/connections.js';
import { riskItEngine } from './modes/riskIt.js';
import { timelineEngine } from './modes/timeline.js';
import { top25Engine } from './modes/top25.js';
import { buzzerEngine } from './modes/buzzer.js';
import { impostorEngine } from './modes/impostor.js';
import { auctionEngine } from './modes/auction.js';
import { tiebreakEngine } from './modes/tiebreak.js';
import { whoAmIEngine } from './modes/whoAmI.js';

export const ENGINES: Partial<Record<ModeKey, Engine>> = {
  higher_lower: higherLowerEngine as unknown as Engine,
  last_man_standing: lastManStandingEngine as unknown as Engine,
  missing_xi: missingXiEngine as unknown as Engine,
  guess_the_match: guessTheMatchEngine as unknown as Engine,
  connections: connectionsEngine as unknown as Engine,
  risk_it: riskItEngine as unknown as Engine,
  timeline: timelineEngine as unknown as Engine,
  top25: top25Engine as unknown as Engine,
  buzzer: buzzerEngine as unknown as Engine,
  impostor: impostorEngine as unknown as Engine,
  auction: auctionEngine as unknown as Engine,
  who_am_i: whoAmIEngine as unknown as Engine,
};

export const TIEBREAK_ENGINE = tiebreakEngine as unknown as Engine;

export function engineFor(key: ModeKey | 'tiebreak'): Engine {
  if (key === 'tiebreak') return TIEBREAK_ENGINE;
  const e = ENGINES[key];
  if (!e) throw new Error(`No engine for mode ${key}`);
  return e;
}
