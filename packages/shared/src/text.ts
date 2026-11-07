/**
 * Normalizes free-text answers for alias matching: case-folds, strips Latin diacritics,
 * Arabic tashkeel/tatweel and alef variants, punctuation and redundant whitespace.
 * Matching is against verified alias lists only; it never decides correctness by similarity.
 */
export function normalizeAnswer(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics + tatweel
    .replace(/[آأإ]/g, 'ا') // alef variants -> bare alef
    .replace(/ى/g, 'ي') // alef maqsura -> ya
    .replace(/ة/g, 'ه') // ta marbuta -> ha
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function matchesAlias(input: string, aliases: readonly string[]): boolean {
  const n = normalizeAnswer(input);
  if (!n) return false;
  return aliases.some((a) => normalizeAnswer(a) === n);
}
