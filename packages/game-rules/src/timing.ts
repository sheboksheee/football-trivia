/** All durations in milliseconds. Defaults are the approved/proposed values from the GDD. */
export interface Timing {
  appealWindow: number;
  reconnectGrace: number;
  modeIntro: number;
  modeResults: number;
  higherLowerQuestion: number;
  timelineAnswer: number;
  timelineIntro: number;
  lmsQuestion: number;
  missingXiQuestion: number;
  missingXiHints: [number, number];
  guessMatchQuestion: number;
  guessMatchClues: [number, number, number];
  connectionsQuestion: number;
  riskChoose: number;
  riskAnswer: number;
  buzzerOpen: number;
  buzzerAnswer: number;
  buzzerJudgeGrace: number;
  impostorReveal: number;
  impostorClue: number;
  impostorDiscussion: number;
  impostorVote: number;
  impostorGuess: number;
  top25Turn: number;
  top25Result: number;
  auctionBid: number;
  auctionChallenge: number;
  auctionJudgeStart: number;
  tiebreakQuestion: number;
}

export const DEFAULT_TIMING: Timing = {
  appealWindow: 15_000,
  reconnectGrace: 30_000,
  modeIntro: 10_000,
  modeResults: 15_000,
  higherLowerQuestion: 10_000,
  timelineAnswer: 8_000,
  timelineIntro: 3_000,
  lmsQuestion: 12_000,
  missingXiQuestion: 20_000,
  missingXiHints: [8_000, 14_000],
  guessMatchQuestion: 30_000,
  guessMatchClues: [0, 10_000, 20_000],
  connectionsQuestion: 20_000,
  riskChoose: 10_000,
  riskAnswer: 15_000,
  buzzerOpen: 10_000,
  buzzerAnswer: 8_000,
  buzzerJudgeGrace: 5_000,
  impostorReveal: 15_000,
  impostorClue: 10_000,
  impostorDiscussion: 45_000,
  impostorVote: 15_000,
  impostorGuess: 10_000,
  top25Turn: 15_000,
  top25Result: 2_500,
  auctionBid: 15_000,
  auctionChallenge: 30_000,
  auctionJudgeStart: 15_000,
  tiebreakQuestion: 15_000,
};

/** Scales every duration (used only by automated E2E tests via FT_TIME_SCALE). */
export function scaleTiming(t: Timing, factor: number): Timing {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    out[k] = Array.isArray(v)
      ? v.map((x: number) => Math.round(x * factor))
      : Math.round((v as number) * factor);
  }
  return out as unknown as Timing;
}
