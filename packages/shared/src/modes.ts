/**
 * Mode catalog. Rule summaries mirror the canonical GDD V1.0 §3.
 * rulesStatus:
 *  - APPROVED: all parameters needed to implement are in the canonical spec.
 *  - PROVISIONAL: core rules approved, but some parameters were missing; the implementation uses
 *    clearly labelled PROPOSED defaults (see docs/DECISIONS.md). Must be approved before production.
 *  - BLOCKED: rules too incomplete to implement without inventing gameplay policy. Not playable.
 */
export const MODE_KEYS = [
  'who_am_i',
  'auction',
  'buzzer',
  'connections',
  'higher_lower',
  'timeline',
  'impostor',
  'last_man_standing',
  'risk_it',
  'missing_xi',
  'guess_the_match',
  'top25',
] as const;
export type ModeKey = (typeof MODE_KEYS)[number];

export type RulesStatus = 'APPROVED' | 'PROVISIONAL' | 'BLOCKED';
export type JudgeRequirement = 'required' | 'optional' | 'none';

export interface ModeInfo {
  key: ModeKey;
  number: number;
  name: { en: string; ar: string };
  concept: string;
  rules: string;
  minPlayers: number;
  maxPlayers: number;
  judge: JudgeRequirement;
  rulesStatus: RulesStatus;
  /** Parameters the implementation had to propose. Each needs product approval. */
  proposed: string[];
  /** Why the mode cannot be built yet (BLOCKED only). */
  blockers: string[];
  estimatedMinutes: number;
}

export const MODES: Record<ModeKey, ModeInfo> = {
  who_am_i: {
    key: 'who_am_i',
    number: 1,
    name: { en: 'Who Am I?', ar: 'من أنا؟' },
    concept: 'Progressive identity clues; earlier correct answers score more.',
    rules: '5 staged clues; +5 down to +1 (proposed in GDD).',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Owner delegated the rules (2026-11-09). 6 footballers per game, 40s each.',
      'Five clues, hardest first, one every 8s (0, 8, 16, 24, 32s); clue types vary per player (league, national team, a teammate, club and year, number of clubs, name length/initial).',
      'Every player types one answer (Arabic or English, small typos accepted); it locks at submission. No buzzer.',
      'Correct with 1 clue visible +5, 2 → +4, 3 → +3, 4 → +2, 5 → +1. Wrong or no answer 0 (no penalty, no retry). No speed bonus.',
      'Equal totals share the place (Match Night averaging).',
    ],
    blockers: [],
    estimatedMinutes: 5,
  },
  auction: {
    key: 'auction',
    number: 2,
    name: { en: 'Football Auction + 30 Seconds', ar: 'مزاد كرة القدم + 30 ثانية' },
    concept: 'Players bid how many valid footballers they can name in a category.',
    rules:
      'Last bidder is challenged by the last dropper. 30s begins on the judge’s first valid tap. Success: bidder +5. Failure: bidder −2, challenger +5. Undo never resets the timer.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'required',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'One auction per player (each player opens one category); opener rotates by seat.',
      'Opening bid minimum 1; each raise must exceed the current bid; maximum bid = size of the verified answer universe.',
      '15s per bidding decision; timing out counts as dropping.',
      'If the judge has not made a first valid tap within 15s of the challenge starting, the 30s window starts automatically.',
    ],
    blockers: [],
    estimatedMinutes: 10,
  },
  buzzer: {
    key: 'buzzer',
    number: 3,
    name: { en: 'Buzzer Battle', ar: 'معركة الجرس' },
    concept: 'First accepted buzz answers a spoken football question.',
    rules:
      '10 questions. 8s spoken answer window. Correct +3, wrong/timeout −1. Server orders buzzes; a wrong answer reopens the buzzer for remaining players, once each.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'required',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Buzzer stays open 10s per question (and 10s after each reopen); if nobody buzzes, the answer is revealed with no points.',
      'Judge may record a verdict up to 5s after the 8s answer window; with no verdict the buzz is voided (no points either way) and logged.',
    ],
    blockers: [],
    estimatedMinutes: 8,
  },
  connections: {
    key: 'connections',
    number: 4,
    name: { en: 'Connections', ar: 'الروابط' },
    concept: 'Find a common connection among four football entities.',
    rules:
      '8 puzzles, 20s each. Earliest valid correct +3, other correct +2. Ordered by submission timestamp, not grading time. Ambiguous alternative links are reviewed.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'optional',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'One typed submission per player per puzzle.',
      'Answers not matching a verified alias go to the judge as “alternative link” review when a judge is present; otherwise they are graded wrong (appealable).',
    ],
    blockers: [],
    estimatedMinutes: 5,
  },
  higher_lower: {
    key: 'higher_lower',
    number: 5,
    name: { en: 'Higher or Lower', ar: 'أعلى أم أقل' },
    concept: 'Compare a shared, precisely scoped football statistic.',
    rules:
      '5 simultaneous comparisons, 10s each. Correct +2. Non-overlapping streak pairs (1,2) and (3,4) +1 each. Perfect +3. Maximum 15.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'APPROVED',
    proposed: [],
    blockers: [],
    estimatedMinutes: 2,
  },
  timeline: {
    key: 'timeline',
    number: 6,
    name: { en: 'Timeline: History Duel', ar: 'الخط الزمني: مبارزة التاريخ' },
    concept: 'Choose which of two verified football events occurred first.',
    rules:
      'Each player initiates 2 challenges. 8s. Exactly one correct +3; both correct +1 each; both wrong 0. Balanced pairings.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Opponents are assigned by the server (initiator i faces seat i+1, then i+2, wrapping, skipping self) so every player has the same number of duels.',
    ],
    blockers: [],
    estimatedMinutes: 4,
  },
  impostor: {
    key: 'impostor',
    number: 7,
    name: { en: 'The Impostor: Blind Impostor', ar: 'المحتال: المحتال الأعمى' },
    concept: 'One player does not see the secret footballer; others give spoken clues.',
    rules:
      '3–6 players, 1 impostor per round. 15s reveal, two clue cycles of 10s per player, 45s discussion, 15s vote, 10s guess for a caught impostor. Correct vote +2, escape +4, caught-and-guessed +3.',
    minPlayers: 3,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Rounds = number of players; every player is impostor exactly once in a seeded random order.',
      'Impostor is “caught” only with strictly the most votes; a tie at the top means the impostor escapes.',
      'Players cannot vote for themselves; no vote = abstain.',
    ],
    blockers: [],
    estimatedMinutes: 12,
  },
  last_man_standing: {
    key: 'last_man_standing',
    number: 8,
    name: { en: 'Last Man Standing: Survival Arena', ar: 'آخر الصامدين: ساحة البقاء' },
    concept: 'Shared questions, elimination through lost hearts.',
    rules:
      '3 hearts. 12s MCQ. Wrong/timeout loses a heart. Up to 15 questions. Placement +5/+3/+1; perfect survival +1.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Ends when at most one player is alive or after 15 questions.',
      'Order: alive before eliminated, then more hearts, then later elimination. Equal keys (incl. simultaneous elimination) share the place; placement points of shared places are averaged exactly.',
      'Perfect survival (+1) = alive at the end with all 3 hearts; added after placement points.',
    ],
    blockers: [],
    estimatedMinutes: 4,
  },
  risk_it: {
    key: 'risk_it',
    number: 9,
    name: { en: 'Risk It', ar: 'خاطر بها' },
    concept: 'Choose a risk level before a four-option question.',
    rules:
      '6 turns each. 10s risk selection, 15s answer. SAFE +1/0, BOLD +3/−1, ALL IN +6/−3. Negatives allowed.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Turns are sequential in seat order (round-robin) so others can watch each risk.',
      'Not choosing a risk within 10s defaults to SAFE. Not answering within 15s counts as wrong.',
    ],
    blockers: [],
    estimatedMinutes: 12,
  },
  missing_xi: {
    key: 'missing_xi',
    number: 10,
    name: { en: 'Missing XI', ar: 'التشكيلة الناقصة' },
    concept: 'Identify a missing starter from a verified historic kickoff XI.',
    rules:
      '10 lineups, 20s each. One irreversible typed answer. Hints offered at 8s and 14s. Correct +5/+3/+1 depending on hints viewed; wrong 0.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'APPROVED',
    proposed: [],
    blockers: [],
    estimatedMinutes: 4,
  },
  guess_the_match: {
    key: 'guess_the_match',
    number: 11,
    name: { en: 'Guess the Match', ar: 'خمّن المباراة' },
    concept: 'Identify a historic fixture from four real matches and three clues.',
    rules:
      '8 matches, 30s each. Clues at 0/10/20s. Correct +5/+3/+1 by clue tier; one confirmed answer; wrong 0; no speed bonus.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'APPROVED',
    proposed: [],
    blockers: [],
    estimatedMinutes: 5,
  },
  top25: {
    key: 'top25',
    number: 12,
    name: { en: 'TOP 25', ar: 'أفضل 25' },
    concept: 'Guess entries in a verified ordered list of 25 names.',
    rules:
      '15s per turn. Rank #N yields N points; duplicates/wrong 0. Snake Draft. Reaching 100 triggers completion of the current equal-turn cycle.',
    minPlayers: 2,
    maxPlayers: 6,
    judge: 'none',
    rulesStatus: 'PROVISIONAL',
    proposed: [
      'Game also ends when all 25 entries are found, or after 25 snake rounds (safety cap).',
      'No mode tie-break: equal final totals share the place (the GDD tie rule is an open BLOCKER; Sudden Draft is NOT implemented).',
    ],
    blockers: [],
    estimatedMinutes: 10,
  },
};

export const PLAYABLE_MODE_KEYS: ModeKey[] = MODE_KEYS.filter((k) => MODES[k].rulesStatus !== 'BLOCKED');

export type PlaylistPreset = 'QUICK' | 'CLASSIC' | 'MARATHON' | 'CUSTOM';
export const PRESET_SIZES: Record<Exclude<PlaylistPreset, 'CUSTOM'>, number> = {
  QUICK: 3,
  CLASSIC: 5,
  MARATHON: 12,
};
