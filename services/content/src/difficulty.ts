import type { DifficultyInfo } from './model.js';

/** RECOMMENDED starting weights (Blueprint C1) — hypotheses to tune, not validated measurements. */
export const DIFFICULTY_WEIGHTS = {
  rarity: 0.3,
  complexity: 0.2,
  distractorSimilarity: 0.2,
  temporalDistance: 0.15,
  recallDepth: 0.15,
} as const;
/** Pilot threshold (Blueprint C2): below this many valid responses difficulty stays PROVISIONAL. */
export const MIN_CALIBRATION_SAMPLE = 50;
const PRIOR_STRENGTH = 10;

export function tierOf(score: number): DifficultyInfo['tier'] {
  return score < 35 ? 'EASY' : score < 65 ? 'MEDIUM' : score < 85 ? 'HARD' : 'EXPERT';
}

export function estimateDifficulty(c: DifficultyInfo['components']): DifficultyInfo {
  const w = DIFFICULTY_WEIGHTS;
  const estimate = Math.round(
    c.rarity * w.rarity +
      c.complexity * w.complexity +
      c.distractorSimilarity * w.distractorSimilarity +
      c.temporalDistance * w.temporalDistance +
      c.recallDepth * w.recallDepth,
  );
  return {
    estimate,
    tier: tierOf(estimate),
    status: 'PROVISIONAL',
    components: c,
    attempts: 0,
    correct: 0,
    posteriorMean: null,
  };
}

/** Maps a difficulty score to the expected probability of a correct answer (prior mean). */
export function priorMean(estimate: number): number {
  return 0.9 - 0.7 * (estimate / 100);
}

/**
 * Beta-binomial calibration. Records attempts; only reclassifies the tier once the number of valid
 * independent responses reaches MIN_CALIBRATION_SAMPLE, so small samples never move a question.
 */
export function recordAttempts(
  d: DifficultyInfo,
  attempts: number,
  correct: number,
  minSample = MIN_CALIBRATION_SAMPLE,
): DifficultyInfo {
  const total = d.attempts + attempts;
  const right = d.correct + correct;
  const p0 = priorMean(d.estimate);
  const alpha = p0 * PRIOR_STRENGTH + right;
  const beta = (1 - p0) * PRIOR_STRENGTH + (total - right);
  const posteriorMean = alpha / (alpha + beta);
  if (total < minSample)
    return { ...d, attempts: total, correct: right, posteriorMean, status: 'PROVISIONAL' };
  const observedScore = Math.max(0, Math.min(100, ((0.9 - posteriorMean) / 0.7) * 100));
  return {
    ...d,
    attempts: total,
    correct: right,
    posteriorMean,
    status: 'CALIBRATED',
    tier: tierOf(observedScore),
  };
}

/** Risk It fairness check (Blueprint C3): expected value per tier for a success probability p. */
export function riskExpectedValues(p: number) {
  return { SAFE: p, BOLD: 4 * p - 1, ALL_IN: 9 * p - 3 };
}
