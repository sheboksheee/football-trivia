/**
 * Answer matching for typed answers (English and Egyptian/Modern Standard Arabic).
 *
 * 1. normalizeAnswer: case-folds, strips Latin diacritics, Arabic tashkeel/tatweel, unifies alef/hamza
 *    variants, ya/alef-maqsura and ta-marbuta/ha, removes punctuation.
 * 2. Comparison also ignores the Arabic definite article ("ال") and club-type tokens (FC, CF, AFC…).
 * 3. Spelling mistakes are tolerated (edit distance scaled to the answer length), but only when the
 *    answer is closer to the correct answer than to any rival (e.g. other teams/players in the same
 *    question). Correctness is still decided against verified alias lists — never by "meaning".
 */
export function normalizeAnswer(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics + tatweel
    .replace(/[آأإٱ]/g, 'ا') // alef variants -> bare alef
    .replace(/ؤ/g, 'و') // waw with hamza -> waw
    .replace(/ئ/g, 'ي') // ya with hamza -> ya
    .replace(/ى/g, 'ي') // alef maqsura -> ya
    .replace(/ة/g, 'ه') // ta marbuta -> ha
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens that carry no identity in club names. */
const NOISE = new Set(['fc', 'cf', 'afc', 'ac', 'sc', 'cfc', 'the', 'club', 'calcio', 'نادي']);

/** Comparison key: normalized, without the Arabic article and noise tokens. */
export function answerKey(input: string): string {
  const tokens = normalizeAnswer(input)
    .replace(/\b(\p{L}) (?=\p{L}\b)/gu, '$1') // "f c" (from F.C.) -> "fc"
    .split(' ')
    .map((t) => (t.length > 3 && t.startsWith('ال') ? t.slice(2) : t)) // "ال" + word
    .filter((t) => t && !NOISE.has(t));
  return tokens.join(' ');
}

/**
 * Edit distance counting insertions, deletions, substitutions and swaps of two adjacent letters
 * (optimal string alignment), with an early exit once `max` is exceeded.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Allowed typos for an answer of this length: none for very short words. */
export function typoTolerance(length: number): number {
  return length <= 3 ? 0 : length <= 5 ? 1 : length <= 10 ? 2 : 3;
}

function closest(input: string, candidates: readonly string[]): number {
  let best = Infinity;
  for (const c of candidates) {
    const k = answerKey(c);
    if (!k) continue;
    best = Math.min(best, editDistance(input, k, 6));
  }
  return best;
}

/**
 * True when `input` names the answer. Exact (normalized) matches always count. A misspelling counts
 * when it is within the tolerance of a correct alias AND strictly closer to it than to every rival.
 */
export function matchesAlias(
  input: string,
  aliases: readonly string[],
  rivals: readonly string[] = [],
): boolean {
  const n = normalizeAnswer(input);
  if (!n) return false;
  if (aliases.some((a) => normalizeAnswer(a) === n)) return true;
  const key = answerKey(input);
  if (!key) return false;
  if (aliases.some((a) => answerKey(a) === key)) return true;
  const dTarget = closest(key, aliases);
  if (dTarget > typoTolerance(key.length)) return false;
  return dTarget < closest(key, rivals);
}

/** Picks the single best-matching option (exact first, then typo-tolerant); null if none or a tie. */
export function bestMatch<T>(
  input: string,
  options: readonly T[],
  aliasesOf: (o: T) => readonly string[],
): T | null {
  const n = normalizeAnswer(input);
  if (!n) return null;
  const exact = options.filter((o) =>
    aliasesOf(o).some((a) => normalizeAnswer(a) === n || answerKey(a) === answerKey(input)),
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const key = answerKey(input);
  if (!key) return null;
  const scored = options.map((o) => ({ o, d: closest(key, aliasesOf(o)) })).sort((a, b) => a.d - b.d);
  const [first, second] = scored;
  if (!first || first.d > typoTolerance(key.length)) return null;
  if (second && second.d === first.d) return null; // ambiguous
  return first.o;
}
