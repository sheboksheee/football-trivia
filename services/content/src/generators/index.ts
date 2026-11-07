import { createHash } from 'node:crypto';
import { createRng, normalizeAnswer, shuffle, type ContentItem, type ContentKind } from '@ft/shared';
import { FIXTURE_COMPETITION, FIXTURE_SEASONS } from '../fixture.js';
import type { GateResult } from '../model.js';
import type { KnowledgeBase } from '../normalize.js';
import { PENDING_SOURCE_ID, SYNTHETIC_SOURCE_ID } from '../sources.js';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A generated, not-yet-gated question. `item.meta` is filled by the pipeline. */
export interface Candidate {
  kind: ContentKind;
  template: string;
  item: DistOmit<ContentItem, 'meta'>;
  factIds: string[];
  entityIds: string[];
  /** canonical-fact fingerprint used for dedupe */
  fingerprint: string;
  validators: GateResult[];
  components: { rarity: number; complexity: number; distractorSimilarity: number; temporalDistance: number; recallDepth: number };
  /** strings that must never appear in clues/hints/prompt before reveal */
  secretStrings: string[];
  /** text shown before the reveal (prompt, options, clues, hints) — checked for answer leakage */
  preRevealText: string[];
}

const fp = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const ok = (gate: GateResult['gate'], message: string): GateResult => ({ gate, passed: true, failureStatus: null, message });
const fail = (gate: GateResult['gate'], failureStatus: GateResult['failureStatus'], message: string): GateResult => ({ gate, passed: false, failureStatus, message });
const temporal = (season: number) => Math.round(((2010 - season) / 9) * 100);
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function generateCandidates(kb: KnowledgeBase, seed = 7): Candidate[] {
  const rng = createRng(seed);
  const out: Candidate[] = [];
  const clubName = (id: string) => kb.clubs.find((c) => c.id === id)!.name;
  const player = (id: string) => kb.players.find((p) => p.id === id)!;
  const stats = kb.seasonStats;
  const statFor = (pid: string, cid: string, season: number) => stats.find((s) => s.playerId === pid && s.clubId === cid && s.season === season);
  const aliasesOf = (id: string) => kb.entities.get(id)?.aliases ?? [];

  // ---------------- MCQ: top scorer of club in season
  for (const c of kb.clubs) {
    for (const season of FIXTURE_SEASONS) {
      const rows = stats.filter((s) => s.clubId === c.id && s.season === season).sort((a, b) => b.goals - a.goals);
      const top = rows[0];
      if (!top || top.goals < 3 || rows[1]?.goals === top.goals) continue;
      const distract = shuffle(rows.slice(1).filter((r) => r.goals > 0), rng).slice(0, 3);
      if (distract.length < 3) continue;
      const opts = shuffle([top, ...distract], rng);
      const options = opts.map((r, i) => ({ id: `o${i + 1}`, label: player(r.playerId).name }));
      const correct = options[opts.indexOf(top)]!.id;
      // Independent validator: recompute from facts; exactly one option is the unique maximum.
      const goalsOf = (pid: string) => statFor(pid, c.id, season)?.goals ?? -1;
      const max = Math.max(...opts.map((o) => goalsOf(o.playerId)));
      const satisfying = opts.filter((o) => goalsOf(o.playerId) === max);
      out.push({
        kind: 'mcq', template: 'mcq.top_scorer_club_season',
        item: { kind: 'mcq', prompt: `Who scored the most league goals for ${c.name} in the ${season} season?`, options, correctOptionId: correct, explanation: `${player(top.playerId).name} scored ${top.goals} league goals for ${c.name} in ${season} (${FIXTURE_COMPETITION}).` },
        factIds: opts.map((o) => o.goalsFactId), entityIds: [c.id, ...opts.map((o) => o.playerId)],
        fingerprint: fp(['top_scorer', c.id, season]),
        validators: [
          satisfying.length === 1 ? ok('DISTRACTORS', '4 unique real players; exactly one satisfies the stem') : fail('DISTRACTORS', 'REJECTED', 'More than one option satisfies the stem'),
          new Set(options.map((o) => o.label)).size === 4 ? ok('IDENTITY', 'Distinct canonical entities') : fail('IDENTITY', 'NEEDS_REVIEW', 'Duplicate option labels'),
        ],
        components: { rarity: clamp(100 - top.goals * 5), complexity: 40, distractorSimilarity: clamp(100 - (top.goals - (distract[0]?.goals ?? 0)) * 15), temporalDistance: temporal(season), recallDepth: 50 },
        secretStrings: [], preRevealText: [],
      });
    }
  }

  // ---------------- MCQ: home ground
  for (const c of kb.clubs) {
    const others = shuffle(kb.clubs.filter((x) => x.id !== c.id), rng).slice(0, 3);
    const opts = shuffle([c, ...others], rng);
    const options = opts.map((x, i) => ({ id: `o${i + 1}`, label: x.stadium }));
    out.push({
      kind: 'mcq', template: 'mcq.home_ground',
      item: { kind: 'mcq', prompt: `Which ground is the home of ${c.name}?`, options, correctOptionId: options[opts.indexOf(c)]!.id, explanation: `${c.name} play at ${c.stadium}.` },
      factIds: opts.map((x) => x.factIds[1]!), entityIds: opts.map((x) => x.id), fingerprint: fp(['home_ground', c.id]),
      validators: [ok('DISTRACTORS', 'Each option is the home ground of exactly one club')],
      components: { rarity: 20, complexity: 10, distractorSimilarity: 30, temporalDistance: 0, recallDepth: 20 },
      secretStrings: [], preRevealText: [],
    });
  }

  // ---------------- MCQ: match score (sampled)
  for (const m of shuffle(kb.matches, rng).slice(0, 220)) {
    const actual = `${m.homeGoals}–${m.awayGoals}`;
    const variants = new Set<string>([actual]);
    const cand = [[m.homeGoals + 1, m.awayGoals], [m.homeGoals, m.awayGoals + 1], [m.awayGoals, m.homeGoals], [Math.max(0, m.homeGoals - 1), m.awayGoals], [m.homeGoals + 1, m.awayGoals + 1]];
    for (const [h, a] of shuffle(cand, rng)) if (variants.size < 4) variants.add(`${h}–${a}`);
    if (variants.size < 4) continue;
    const opts = shuffle([...variants], rng);
    const options = opts.map((label, i) => ({ id: `o${i + 1}`, label }));
    const prompt = `What was the final score when ${clubName(m.homeId)} hosted ${clubName(m.awayId)} on ${m.date}?`;
    out.push({
      kind: 'mcq', template: 'mcq.match_score',
      item: { kind: 'mcq', prompt, options, correctOptionId: options[opts.indexOf(actual)]!.id, explanation: `${clubName(m.homeId)} ${actual} ${clubName(m.awayId)}, ${m.date}.` },
      factIds: [m.factIds[0]!, m.factIds[3]!], entityIds: [m.id, m.homeId, m.awayId], fingerprint: fp(['match_score', m.id]),
      validators: [ok('DISTRACTORS', '4 distinct scorelines; exactly one matches the recorded result')],
      components: { rarity: 85, complexity: 30, distractorSimilarity: 80, temporalDistance: temporal(m.season), recallDepth: 80 },
      secretStrings: [], preRevealText: [],
    });
  }

  // ---------------- MCQ: largest stadium capacity (PENDING-rights source -> must be BLOCKED_RIGHTS)
  {
    const caps = kb.facts.filter((f) => f.sourceId === PENDING_SOURCE_ID && f.predicate === 'stadium_capacity');
    for (let k = 0; k + 4 <= caps.length; k += 4) {
      const group = caps.slice(k, k + 4);
      const max = group.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a));
      const options = group.map((f, i) => ({ id: `o${i + 1}`, label: kb.clubs.find((c) => c.id === f.subject)!.stadium }));
      out.push({
        kind: 'mcq', template: 'mcq.largest_capacity',
        item: { kind: 'mcq', prompt: 'Which of these grounds has the largest seated capacity?', options, correctOptionId: options[group.indexOf(max)]!.id, explanation: 'Capacity from pending-rights feed.' },
        factIds: group.map((f) => f.id), entityIds: group.map((f) => f.subject), fingerprint: fp(['capacity', k]),
        validators: [ok('DISTRACTORS', 'Unique maximum')],
        components: { rarity: 50, complexity: 30, distractorSimilarity: 50, temporalDistance: 0, recallDepth: 50 },
        secretStrings: [], preRevealText: [],
      });
    }
  }

  // ---------------- Higher or Lower: season goals, same scope (same provider, season, definition)
  for (const season of FIXTURE_SEASONS) {
    const rows = shuffle(stats.filter((s) => s.season === season && s.goals > 0), rng);
    for (let k = 0; k + 1 < rows.length && k < 40; k += 2) {
      const a = rows[k]!;
      const b = rows[k + 1]!;
      const pa = player(a.playerId);
      const pb = player(b.playerId);
      out.push({
        kind: 'higher_lower', template: 'hl.season_goals',
        item: { kind: 'higher_lower', statLabel: 'League goals', scope: `${FIXTURE_COMPETITION} ${season} season (club league goals, own goals excluded)`, unit: 'goals', a: { label: `${pa.name} (${clubName(a.clubId)})`, value: a.goals }, b: { label: `${pb.name} (${clubName(b.clubId)})`, value: b.goals } },
        factIds: [a.goalsFactId, b.goalsFactId], entityIds: [a.playerId, b.playerId], fingerprint: fp(['hl_goals', a.playerId, b.playerId, season].sort()),
        validators: [a.goals !== b.goals ? ok('MODE_VALIDATOR', 'Same definition/timeframe; unequal values') : fail('MODE_VALIDATOR', 'REJECTED', 'Equal values cannot be compared')],
        components: { rarity: 60, complexity: 30, distractorSimilarity: clamp(100 - Math.abs(a.goals - b.goals) * 20), temporalDistance: temporal(season), recallDepth: 60 },
        secretStrings: [], preRevealText: [],
      });
    }
  }

  // ---------------- Short answer (Buzzer): which club plays at ground X / top scorer
  for (const c of kb.clubs) {
    out.push({
      kind: 'short_answer', template: 'sa.club_by_ground',
      item: { kind: 'short_answer', prompt: `Which club plays its home matches at ${c.stadium}?`, answer: c.name, aliases: [c.shortName], explanation: `${c.stadium} is the home of ${c.name}.` },
      factIds: [c.factIds[1]!], entityIds: [c.id], fingerprint: fp(['sa_ground', c.id]),
      validators: [kb.clubs.filter((x) => x.stadium === c.stadium).length === 1 ? ok('MODE_VALIDATOR', 'No competing valid answers') : fail('MODE_VALIDATOR', 'REJECTED', 'Ground shared by several clubs')],
      components: { rarity: 25, complexity: 20, distractorSimilarity: 0, temporalDistance: 0, recallDepth: 40 },
      secretStrings: [], preRevealText: [],
    });
  }
  for (const c of kb.clubs) {
    for (const season of FIXTURE_SEASONS) {
      const rows = stats.filter((s) => s.clubId === c.id && s.season === season).sort((a, b) => b.goals - a.goals);
      if (!rows[0] || rows[0].goals < 4 || rows[1]?.goals === rows[0].goals) continue;
      const p = player(rows[0].playerId);
      out.push({
        kind: 'short_answer', template: 'sa.top_scorer',
        item: { kind: 'short_answer', prompt: `Name ${c.name}'s top league scorer in the ${season} season.`, answer: p.name, aliases: aliasesOf(p.id), explanation: `${p.name}: ${rows[0].goals} goals.` },
        factIds: rows.map((r) => r.goalsFactId), entityIds: [c.id, p.id], fingerprint: fp(['sa_top', c.id, season]),
        validators: [ok('MODE_VALIDATOR', 'Unique maximum; aliases map to one canonical player')],
        components: { rarity: clamp(100 - rows[0].goals * 4), complexity: 40, distractorSimilarity: 0, temporalDistance: temporal(season), recallDepth: 80 },
        secretStrings: [], preRevealText: [],
      });
    }
  }

  // ---------------- Connections: four players who all played for club X; alternate-link check
  // Clubs a player STARTED a league match for, derived from verified kickoff XIs.
  const startedFor = new Map<string, Set<string>>();
  const xiFact = new Map<string, string[]>();
  for (const m of kb.matches) {
    for (const [cid, xi] of Object.entries(m.lineups)) {
      const fid = m.factIds.find((id) => kb.factIndex.get(id)?.predicate === `kickoff_xi:${cid}`)!;
      for (const x of xi) {
        if (!startedFor.has(x.playerId)) startedFor.set(x.playerId, new Set());
        startedFor.get(x.playerId)!.add(cid);
        const key = `${x.playerId}:${cid}`;
        if (!xiFact.has(key)) xiFact.set(key, [fid]);
      }
    }
  }
  const clubsOf = (pid: string) => startedFor.get(pid) ?? new Set<string>();
  const startFacts = (pid: string) => [...clubsOf(pid)].flatMap((cid) => xiFact.get(`${pid}:${cid}`) ?? []);
  for (const c of kb.clubs) {
    const members = kb.players.filter((p) => clubsOf(p.id).has(c.id));
    for (let k = 0; k < 4; k++) {
      const four = shuffle(members, rng).slice(0, 4);
      if (four.length < 4) continue;
      // Alternate links: another shared club, or a shared nationality => ambiguity.
      const shared = [...clubsOf(four[0]!.id)].filter((cid) => cid !== c.id && four.every((p) => clubsOf(p.id).has(cid)));
      const sameNat = four.every((p) => p.nationality === four[0]!.nationality);
      out.push({
        kind: 'connection', template: 'conn.same_club',
        item: { kind: 'connection', entities: four.map((p) => p.name), link: c.name, aliases: [c.shortName, `played for ${c.shortName}`, `${c.shortName} players`], explanation: `All four started at least one league match for ${c.name} (${FIXTURE_COMPETITION} kickoff XIs).` },
        factIds: four.flatMap((p) => startFacts(p.id)), entityIds: [c.id, ...four.map((p) => p.id)],
        fingerprint: fp(['conn', c.id, four.map((p) => p.id).sort()]),
        validators: [
          shared.length > 0 ? fail('MODE_VALIDATOR', 'REJECTED', `Alternate link: all four also started for ${shared.map(clubName).join(', ')}`) : ok('MODE_VALIDATOR', 'All four satisfy the link; no other shared club'),
          sameNat ? fail('CLUES', 'NEEDS_REVIEW', `Possible alternate link: all four are ${four[0]!.nationality} nationals`) : ok('CLUES', 'No shared nationality'),
        ],
        components: { rarity: 70, complexity: 70, distractorSimilarity: 50, temporalDistance: 50, recallDepth: 80 },
        secretStrings: [c.name, c.shortName], preRevealText: four.map((p) => p.name),
      });
    }
  }

  // ---------------- Timeline: which of two matches came first (labels must not reveal dates)
  const label = (m: (typeof kb.matches)[number]) => `${clubName(m.homeId)} ${m.homeGoals}–${m.awayGoals} ${clubName(m.awayId)}`;
  const labelCount = new Map<string, number>();
  for (const m of kb.matches) labelCount.set(label(m), (labelCount.get(label(m)) ?? 0) + 1);
  const pool = shuffle(kb.matches, rng).slice(0, 260);
  for (let k = 0; k + 1 < pool.length; k += 2) {
    const [x, y] = [pool[k]!, pool[k + 1]!];
    const gapDays = Math.abs(Date.parse(x.date) - Date.parse(y.date)) / 86400000;
    const earlier = x.date < y.date ? x : y;
    const unique = labelCount.get(label(x)) === 1 && labelCount.get(label(y)) === 1;
    out.push({
      kind: 'timeline', template: 'tl.match_order',
      item: { kind: 'timeline', prompt: 'Which of these league matches was played first?', events: [{ id: 'e1', label: label(x), date: x.date }, { id: 'e2', label: label(y), date: y.date }], earlierId: earlier === x ? 'e1' : 'e2' },
      factIds: [x.factIds[0]!, x.factIds[3]!, y.factIds[0]!, y.factIds[3]!], entityIds: [x.id, y.id], fingerprint: fp(['tl', [x.id, y.id].sort()]),
      validators: [
        gapDays >= 14 ? ok('MODE_VALIDATOR', 'Dates precise and at least 14 days apart') : fail('MODE_VALIDATOR', 'REJECTED', 'Events too close together'),
        unique ? ok('IDENTITY', 'Each event label identifies exactly one match') : fail('IDENTITY', 'REJECTED', 'Event label matches several matches (ambiguous)'),
      ],
      components: { rarity: 80, complexity: 50, distractorSimilarity: clamp(100 - gapDays / 10), temporalDistance: temporal(earlier.season), recallDepth: 70 },
      secretStrings: [x.date, y.date], preRevealText: [label(x), label(y)],
    });
  }

  // ---------------- Impostor: recognisable footballers (career league goals >= 25)
  const careerGoals = new Map<string, number>();
  for (const s of stats) careerGoals.set(s.playerId, (careerGoals.get(s.playerId) ?? 0) + s.goals);
  for (const p of kb.players.filter((x) => (careerGoals.get(x.id) ?? 0) >= 25)) {
    out.push({
      kind: 'impostor', template: 'imp.footballer',
      item: { kind: 'impostor', footballer: p.name, aliases: aliasesOf(p.id), context: `${p.position === 'FW' ? 'Forward' : p.position === 'MF' ? 'Midfielder' : p.position === 'DF' ? 'Defender' : 'Goalkeeper'} · ${[...clubsOf(p.id)].map(clubName).join(', ')}` },
      factIds: p.factIds, entityIds: [p.id], fingerprint: fp(['imp', p.id]),
      validators: [ok('MODE_VALIDATOR', 'Known footballer entity with verified career record')],
      components: { rarity: clamp(100 - (careerGoals.get(p.id) ?? 0)), complexity: 20, distractorSimilarity: 0, temporalDistance: 30, recallDepth: 30 },
      secretStrings: [], preRevealText: [],
    });
  }

  // ---------------- Missing XI: verified kickoff XI with one starter hidden
  for (const m of shuffle(kb.matches, rng).slice(0, 120)) {
    const clubId = rng() < 0.5 ? m.homeId : m.awayId;
    const xi = m.lineups[clubId]!;
    const hideIdx = 1 + Math.floor(rng() * 10);
    const hidden = player(xi[hideIdx]!.playerId);
    const names = xi.map((s) => player(s.playerId).name);
    const opp = clubId === m.homeId ? m.awayId : m.homeId;
    const hints: [string, string] = [`Position: ${xi[hideIdx]!.position}; nationality: ${hidden.nationality}`, `Wore shirt number ${xi[hideIdx]!.shirt}`];
    out.push({
      kind: 'missing_xi', template: 'xi.kickoff',
      item: {
        kind: 'missing_xi', match: `${clubName(m.homeId)} ${m.homeGoals}–${m.awayGoals} ${clubName(m.awayId)}`, date: m.date, team: clubName(clubId), formation: '4-4-2',
        slots: xi.map((s, k) => ({ slot: k, position: s.position, player: k === hideIdx ? null : player(s.playerId).name })),
        missingAnswer: hidden.name, aliases: aliasesOf(hidden.id), hints,
      },
      factIds: [m.factIds.find((id) => kb.factIndex.get(id)?.predicate === `kickoff_xi:${clubId}`)!, m.factIds[0]!], entityIds: [m.id, ...xi.map((s) => s.playerId)],
      fingerprint: fp(['xi', m.id, clubId, hideIdx]),
      validators: [
        new Set(xi.map((s) => s.playerId)).size === 11 ? ok('MODE_VALIDATOR', '11 unique kickoff starters (not substitutes)') : fail('MODE_VALIDATOR', 'REJECTED', 'Lineup does not have 11 unique starters'),
        ok('CLUES', `Hints are generic attributes; opponent ${clubName(opp)}`),
      ],
      components: { rarity: 85, complexity: 60, distractorSimilarity: 40, temporalDistance: temporal(m.season), recallDepth: 90 },
      secretStrings: [hidden.name, ...aliasesOf(hidden.id)], preRevealText: [...hints, ...names.filter((_, k) => k !== hideIdx)],
    });
  }

  // ---------------- Guess the Match: 4 real matches, 3 clues indirect -> direct
  for (const m of shuffle(kb.matches, rng).slice(0, 120)) {
    const same = kb.matches.filter((x) => x.season === m.season && x.id !== m.id);
    const sameVenue = shuffle(same.filter((x) => x.venue === m.venue), rng).slice(0, 1);
    const rest = shuffle(same.filter((x) => x.venue !== m.venue), rng).slice(0, 3 - sameVenue.length);
    const opts = shuffle([m, ...sameVenue, ...rest], rng);
    const options = opts.map((x, i) => ({ id: `o${i + 1}`, label: `${clubName(x.homeId)} vs ${clubName(x.awayId)}` }));
    const clues: [string, string, string] = [`Played in the ${m.season} ${FIXTURE_COMPETITION} season`, `Venue: ${m.venue}`, `Final score ${m.homeGoals}–${m.awayGoals}`];
    const fits = (x: typeof m) => x.season === m.season && x.venue === m.venue && x.homeGoals === m.homeGoals && x.awayGoals === m.awayGoals;
    const fitting = opts.filter(fits);
    const firstClueUnique = opts.filter((x) => x.season === m.season).length === 1;
    out.push({
      kind: 'guess_match', template: 'gm.fixture',
      item: { kind: 'guess_match', options, correctOptionId: options[opts.indexOf(m)]!.id, clues },
      factIds: opts.flatMap((x) => [x.factIds[0]!, x.factIds[3]!, x.factIds[4]!]), entityIds: opts.map((x) => x.id),
      fingerprint: fp(['gm', m.id]),
      validators: [
        fitting.length === 1 ? ok('DISTRACTORS', 'All options are real matches; exactly one fits every clue') : fail('DISTRACTORS', 'REJECTED', 'A distractor fits the full clue sequence'),
        !firstClueUnique ? ok('CLUES', 'Clues become gradually more informative') : fail('CLUES', 'NEEDS_REVIEW', 'First clue alone identifies the match'),
      ],
      components: { rarity: 75, complexity: 60, distractorSimilarity: 60, temporalDistance: temporal(m.season), recallDepth: 70 },
      secretStrings: [], preRevealText: options.map((o) => o.label),
    });
  }

  // ---------------- TOP 25 lists from a single coherent metric snapshot, documented tie-break
  const appsTotal = new Map<string, number>();
  for (const s of stats) appsTotal.set(s.playerId, (appsTotal.get(s.playerId) ?? 0) + s.apps);
  const lists: Array<{ title: string; scope: string; rows: Array<{ id: string; v: number; tb: number }>; factIds: string[]; key: string }> = [];
  const goalsRows = (filter: (s: (typeof stats)[number]) => boolean) => {
    const g = new Map<string, number>();
    const a = new Map<string, number>();
    for (const s of stats.filter(filter)) {
      g.set(s.playerId, (g.get(s.playerId) ?? 0) + s.goals);
      a.set(s.playerId, (a.get(s.playerId) ?? 0) + s.apps);
    }
    // tie-break: fewer league starts ranks higher (documented in scope)
    return [...g.entries()].map(([id, v]) => ({ id, v, tb: -(a.get(id) ?? 0) }));
  };
  const TB = 'ties broken by fewer league starts';
  lists.push({ title: 'All-time league top scorers', scope: `${FIXTURE_COMPETITION} 2001–2010, league goals; ${TB}`, rows: goalsRows(() => true), factIds: stats.flatMap((s) => [s.goalsFactId, s.appsFactId]), key: 'goals_all' });
  for (const [from, to] of [[2001, 2005], [2006, 2010]] as const) {
    lists.push({ title: `League top scorers ${from}–${to}`, scope: `${FIXTURE_COMPETITION} ${from}–${to}, league goals; ${TB}`, rows: goalsRows((s) => s.season >= from && s.season <= to), factIds: stats.filter((s) => s.season >= from && s.season <= to).flatMap((s) => [s.goalsFactId, s.appsFactId]), key: `goals_${from}` });
  }
  for (const c of kb.clubs) {
    lists.push({ title: `${c.name} all-time league top scorers`, scope: `${FIXTURE_COMPETITION} 2001–2010, league goals for ${c.name}; ${TB}`, rows: goalsRows((s) => s.clubId === c.id), factIds: stats.filter((s) => s.clubId === c.id).flatMap((s) => [s.goalsFactId, s.appsFactId]), key: `goals_${c.id}` });
  }
  lists.push({ title: 'Most league starts', scope: `${FIXTURE_COMPETITION} 2001–2010, league starts (no tie-break)`, rows: [...appsTotal.entries()].map(([id, v]) => ({ id, v, tb: 0 })), factIds: stats.map((s) => s.appsFactId), key: 'apps_all' });
  for (const l of lists) {
    const sorted = [...l.rows].sort((a, b) => b.v - a.v || b.tb - a.tb);
    const top = sorted.slice(0, 25);
    const same = (x?: { v: number; tb: number }, y?: { v: number; tb: number }) => !!x && !!y && x.v === y.v && x.tb === y.tb;
    const ties = top.some((r, i) => i > 0 && same(top[i - 1], r)) || same(sorted[25], top[24]);
    out.push({
      kind: 'top25', template: 'top25.metric',
      item: { kind: 'top25', title: l.title, scope: l.scope, entries: top.map((r, i) => ({ rank: i + 1, label: player(r.id).name, aliases: aliasesOf(r.id), metric: `${r.v}` })) },
      factIds: l.factIds, entityIds: top.map((r) => r.id), fingerprint: fp(['top25', l.key]),
      validators: [
        top.length === 25 ? ok('MODE_VALIDATOR', 'Exactly 25 unique ranks') : fail('MODE_VALIDATOR', 'REJECTED', 'Fewer than 25 entries'),
        ties ? fail('MODE_VALIDATOR', 'REJECTED', 'Unresolved tie inside the list or at the 25/26 boundary after the documented tie-break') : ok('MODE_VALIDATOR', 'Strictly ordered after documented tie-break; no boundary tie'),
      ],
      components: { rarity: 60, complexity: 70, distractorSimilarity: 0, temporalDistance: 50, recallDepth: 90 },
      secretStrings: [], preRevealText: [],
    });
  }

  // ---------------- Auction: complete answer universe for a precisely scoped category
  for (const c of kb.clubs) {
    const universe = kb.players.filter((p) => clubsOf(p.id).has(c.id));
    const names = universe.map((p) => normalizeAnswer(p.name));
    out.push({
      kind: 'auction', template: 'auction.club_players',
      item: { kind: 'auction', category: `Players who started a league match for ${c.name}`, scope: `${FIXTURE_COMPETITION} 2001–2010 kickoff XIs`, universe: universe.map((p) => ({ label: p.name, aliases: aliasesOf(p.id) })) },
      factIds: universe.flatMap((p) => startFacts(p.id)), entityIds: universe.map((p) => p.id),
      fingerprint: fp(['auction', c.id]),
      validators: [new Set(names).size === names.length && universe.length >= 5 ? ok('MODE_VALIDATOR', `Precisely scoped universe of ${universe.length} players`) : fail('MODE_VALIDATOR', 'REJECTED', 'Universe ambiguous or too small')],
      components: { rarity: 50, complexity: 50, distractorSimilarity: 0, temporalDistance: 40, recallDepth: 90 },
      secretStrings: [], preRevealText: [],
    });
  }
  void SYNTHETIC_SOURCE_ID;
  return out;
}
