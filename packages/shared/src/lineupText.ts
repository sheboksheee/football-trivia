/**
 * Turns a pasted list of 11 starters into structured rows, so the owner can copy a line-up from a
 * match page instead of filling 11 rows by hand.
 *  - one player per line, in order: goalkeeper, defenders, midfielders, forwards;
 *  - positions follow the formation (4-3-3 → 1 GK, 4 DF, 3 MF, 3 FW) unless a line names one
 *    (GK/DF/MF/FW, or Arabic حارس/دفاع/مدافع/وسط/هجوم/مهاجم);
 *  - a shirt number at the start or end of a line ("23 Emiliano Martínez", "Messi 10") is kept;
 *  - list bullets, dots, dashes and "(c)" captain marks are removed.
 */
export type LineupPos = 'GK' | 'DF' | 'MF' | 'FW';
export interface ParsedPlayer {
  name: string;
  position: LineupPos;
  shirt: number | null;
}

const POS_WORDS: Array<[RegExp, LineupPos]> = [
  [/^(gk|goalkeeper|حارس(\s*مرمى)?)$/iu, 'GK'],
  [/^(df|defender|دفاع|مدافع)$/iu, 'DF'],
  [/^(mf|midfielder|وسط|لاعب\s*وسط)$/iu, 'MF'],
  [/^(fw|forward|striker|هجوم|مهاجم)$/iu, 'FW'],
];

export function formationPositions(formation: string): LineupPos[] | null {
  if (!/^\d(-\d){2,4}$/.test(formation)) return null;
  const lines = formation.split('-').map(Number);
  if (lines.reduce((a, b) => a + b, 0) !== 10) return null;
  const out: LineupPos[] = ['GK'];
  const n = lines.length;
  lines.forEach((count, i) => {
    // first line defenders, last line forwards, everything between midfield
    const pos: LineupPos = i === 0 ? 'DF' : i === n - 1 ? 'FW' : 'MF';
    for (let k = 0; k < count; k++) out.push(pos);
  });
  return out;
}

export function parseLineupText(
  text: string,
  formation: string,
): { ok: true; players: ParsedPlayer[] } | { ok: false; error: string } {
  const slots = formationPositions(formation);
  if (!slots) return { ok: false, error: 'Formation must look like 4-3-3 and add up to 10' };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 11) return { ok: false, error: `Paste exactly 11 lines (got ${lines.length})` };
  const players = lines.map((raw, i): ParsedPlayer => {
    let line = raw
      .replace(/^[\s•·*\-–—.)]+/u, '')
      .replace(/\((c|captain|ك)\)/giu, '')
      .trim();
    let position: LineupPos = slots[i]!;
    // position word in brackets or as a separate token at either end
    const bracket = /[([]([^)\]]+)[)\]]/u.exec(line);
    for (const cand of [bracket?.[1], line.split(/\s+/)[0], line.split(/\s+/).at(-1)]) {
      const hit = cand ? POS_WORDS.find(([re]) => re.test(cand.trim())) : undefined;
      if (hit) {
        position = hit[1];
        line = line.replace(bracket && cand === bracket[1] ? bracket[0] : cand!, '').trim();
        break;
      }
    }
    let shirt: number | null = null;
    const lead = /^(\d{1,2})[\s.:)\-–]+(.+)$/u.exec(line);
    const tail = /^(.+?)[\s(#]+(\d{1,2})\)?$/u.exec(line);
    if (lead) [shirt, line] = [Number(lead[1]), lead[2]!];
    else if (tail) [shirt, line] = [Number(tail[2]), tail[1]!];
    return { name: line.replace(/\s+/g, ' ').trim(), position, shirt: shirt && shirt <= 99 ? shirt : null };
  });
  const empty = players.findIndex((p) => p.name.length < 2);
  if (empty >= 0) return { ok: false, error: `Line ${empty + 1} has no name` };
  return { ok: true, players };
}
