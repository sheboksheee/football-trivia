/**
 * football-data.org snapshots -> canonical entities + scoped facts -> question candidates.
 * Only completed seasons and FINISHED matches are used, so questions never depend on moving data.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createRng, shuffle } from '@ft/shared';
import type { Candidate } from '../generators/index.js';
import type { Entity, Fact, GateResult, RawSnapshot } from '../model.js';
import { FOOTBALL_DATA_SOURCE_ID } from '../sources.js';

// ---------------------------------------------------------------- runtime validation of provider payloads
const Team = z
  .object({ id: z.number(), name: z.string(), shortName: z.string().nullish(), tla: z.string().nullish() })
  .passthrough();
const TeamFull = Team.extend({ venue: z.string().nullish(), founded: z.number().nullish() });
const Competition = z
  .object({ id: z.number(), name: z.string(), code: z.string().nullish(), type: z.string().nullish() })
  .passthrough();
const Season = z.object({ id: z.number(), startDate: z.string(), endDate: z.string() }).passthrough();
const Match = z
  .object({
    id: z.number(),
    utcDate: z.string(),
    status: z.string(),
    matchday: z.number().nullish(),
    stage: z.string().nullish(),
    venue: z.string().nullish(),
    season: Season.partial({ id: true }).nullish(),
    homeTeam: Team.partial({ name: true }).extend({ id: z.number().nullable() }),
    awayTeam: Team.partial({ name: true }).extend({ id: z.number().nullable() }),
    score: z
      .object({
        duration: z.string().nullish(),
        fullTime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
      })
      .passthrough(),
  })
  .passthrough();
const MatchesResp = z.object({ competition: Competition, matches: z.array(Match) }).passthrough();
const Row = z
  .object({
    position: z.number(),
    team: Team,
    playedGames: z.number(),
    won: z.number(),
    draw: z.number(),
    lost: z.number(),
    points: z.number(),
    goalsFor: z.number(),
    goalsAgainst: z.number(),
    goalDifference: z.number(),
  })
  .passthrough();
const StandingsResp = z
  .object({
    competition: Competition,
    season: Season,
    standings: z.array(
      z
        .object({
          stage: z.string().nullish(),
          type: z.string(),
          group: z.string().nullish(),
          table: z.array(Row),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const TeamsResp = z
  .object({ competition: Competition, season: Season.nullish(), teams: z.array(TeamFull) })
  .passthrough();

// ---------------------------------------------------------------- knowledge base
export interface FdTeam {
  entityId: string;
  name: string;
  shortName: string | null;
  venue: string | null;
  venueFactId: string | null;
}
export interface FdMatch {
  entityId: string;
  competition: string;
  competitionCode: string;
  season: string;
  date: string;
  matchday: number | null;
  stage: string | null;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  regular: boolean;
  factIds: { date: string; score: string; home: string; away: string; matchday: string | null };
}
export interface FdTable {
  competition: string;
  competitionCode: string;
  season: string;
  cutoff: string;
  complete: boolean;
  /** Teams involved in a match decided off the pitch (AWARDED); their table rows need a human check. */
  awardedTeams: string[];
  rows: Array<{
    team: string;
    position: number;
    points: number;
    goalsFor: number;
    factIds: { position: string; points: string; goalsFor: string };
  }>;
}
export interface FdKB {
  entities: Map<string, Entity>;
  facts: Fact[];
  factIndex: Map<string, Fact>;
  snapshots: Map<string, RawSnapshot>;
  teams: Map<string, FdTeam>;
  matches: FdMatch[];
  tables: FdTable[];
  invalid: Array<{ snapshotId: string; error: string }>;
  /** Per competition|season: total matches, completed (FINISHED or AWARDED), awarded team ids. */
  seasonSummary: Map<string, { total: number; done: number; awardedTeams: Set<string> }>;
}

export function seasonLabel(start: string, end: string): string {
  const a = start.slice(0, 4);
  const b = end.slice(0, 4);
  return a === b ? a : `${a}/${b.slice(2)}`;
}

/** Normalises football-data snapshots. `today` decides which seasons are complete. */
export function normalizeFootballData(snaps: RawSnapshot[], today: string): FdKB {
  const kb: FdKB = {
    entities: new Map(),
    facts: [],
    factIndex: new Map(),
    snapshots: new Map(),
    teams: new Map(),
    matches: [],
    tables: [],
    invalid: [],
    seasonSummary: new Map(),
  };
  let n = 0;
  const fact = (
    subject: string,
    predicate: string,
    value: string | number,
    scope: Fact['scope'],
    snap: RawSnapshot,
  ) => {
    const f: Fact = {
      id: `fdfact_${++n}`,
      subject,
      predicate,
      value,
      scope,
      sourceId: FOOTBALL_DATA_SOURCE_ID,
      evidenceId: snap.id,
      version: 1,
      status: 'ACTIVE',
    };
    kb.facts.push(f);
    kb.factIndex.set(f.id, f);
    return f.id;
  };
  const teamEntity = (t: z.infer<typeof Team>, snap: RawSnapshot) => {
    const id = `fd_team_${t.id}`;
    const prev = kb.entities.get(id);
    const aliases = [t.shortName].filter((x): x is string => !!x && x !== t.name);
    if (prev) prev.aliases = [...new Set([...prev.aliases, ...aliases])];
    else
      kb.entities.set(id, {
        id,
        type: 'CLUB',
        name: t.name,
        names: { en: t.name },
        aliases,
        sourceRefs: { [snap.sourceId]: String(t.id) },
      });
    if (!kb.teams.has(id))
      kb.teams.set(id, {
        entityId: id,
        name: t.name,
        shortName: t.shortName ?? null,
        venue: null,
        venueFactId: null,
      });
    return id;
  };
  const relevant = snaps.filter((s) => s.sourceId === FOOTBALL_DATA_SOURCE_ID);
  for (const s of relevant) kb.snapshots.set(s.id, s);
  // Teams first (venues), then matches (season completeness), then standings.
  const order = ['fd_teams', 'fd_matches', 'fd_standings'];
  for (const s of [...relevant].sort((a, b) => order.indexOf(a.recordType) - order.indexOf(b.recordType))) {
    try {
      if (s.recordType === 'fd_teams') {
        const d = TeamsResp.parse(s.payload);
        const scope = {
          competition: d.competition.name,
          season: d.season ? seasonLabel(d.season.startDate, d.season.endDate) : null,
          cutoff: s.retrievedAt.slice(0, 10),
          statDefinition: null,
        };
        for (const t of d.teams) {
          const id = teamEntity(t, s);
          if (t.venue) {
            const fid = fact(id, 'home_venue', t.venue, scope, s);
            const team = kb.teams.get(id)!;
            if (!team.venue) Object.assign(team, { venue: t.venue, venueFactId: fid });
          }
        }
      } else if (s.recordType === 'fd_standings') {
        const d = StandingsResp.parse(s.payload);
        const season = seasonLabel(d.season.startDate, d.season.endDate);
        const total = d.standings.find(
          (x) => x.type === 'TOTAL' && (x.stage ?? 'REGULAR_SEASON') === 'REGULAR_SEASON' && !x.group,
        );
        if (!total || d.competition.type !== 'LEAGUE') continue;
        const played = total.table.map((r) => r.playedGames);
        const allPlayed =
          played.every((p) => p === played[0]) && (played[0] ?? 0) >= 2 * (total.table.length - 1);
        const summary = kb.seasonSummary.get(`${d.competition.code ?? d.competition.id}|${season}`);
        const n = total.table.length;
        // Complete = season over AND (every team played every game, OR every scheduled match is
        // FINISHED/AWARDED). Awarded results are decided off the pitch; flagged for human review.
        const allMatchesDone = !!summary && summary.total === n * (n - 1) && summary.done === summary.total;
        const complete = d.season.endDate < today && (allPlayed || allMatchesDone);
        const awardedTeams = summary ? [...summary.awardedTeams] : [];
        const scope = (def: string) => ({
          competition: d.competition.name,
          season,
          cutoff: d.season.endDate,
          statDefinition: def,
        });
        const rows = total.table.map((r) => {
          const team = teamEntity(r.team, s);
          return {
            team,
            position: r.position,
            points: r.points,
            goalsFor: r.goalsFor,
            factIds: {
              position: fact(
                team,
                'final_position',
                r.position,
                scope('final league position, regular season'),
                s,
              ),
              points: fact(team, 'league_points', r.points, scope('league points, regular season table'), s),
              goalsFor: fact(
                team,
                'league_goals_for',
                r.goalsFor,
                scope('league goals scored, regular season table'),
                s,
              ),
            },
          };
        });
        kb.tables.push({
          competition: d.competition.name,
          competitionCode: d.competition.code ?? String(d.competition.id),
          season,
          cutoff: d.season.endDate,
          complete,
          awardedTeams,
          rows,
        });
      } else if (s.recordType === 'fd_matches') {
        const d = MatchesResp.parse(s.payload);
        for (const m of d.matches) {
          {
            const fSeason = (s.payload as { filters?: { season?: string } }).filters?.season;
            const label = m.season
              ? seasonLabel(m.season.startDate, m.season.endDate)
              : (fSeason ?? m.utcDate.slice(0, 4));
            const key = `${d.competition.code ?? d.competition.id}|${label}`;
            const sum = kb.seasonSummary.get(key) ?? { total: 0, done: 0, awardedTeams: new Set<string>() };
            sum.total++;
            if (m.status === 'FINISHED' || m.status === 'AWARDED') sum.done++;
            if (m.status === 'AWARDED') {
              if (m.homeTeam.id !== null) sum.awardedTeams.add(`fd_team_${m.homeTeam.id}`);
              if (m.awayTeam.id !== null) sum.awardedTeams.add(`fd_team_${m.awayTeam.id}`);
            }
            kb.seasonSummary.set(key, sum);
          }
          if (
            m.status !== 'FINISHED' ||
            m.homeTeam.id === null ||
            m.awayTeam.id === null ||
            !m.homeTeam.name ||
            !m.awayTeam.name
          )
            continue;
          const { home: hg, away: ag } = m.score.fullTime;
          if (hg === null || ag === null) continue;
          const home = teamEntity(
            { id: m.homeTeam.id, name: m.homeTeam.name, shortName: m.homeTeam.shortName ?? null, tla: null },
            s,
          );
          const away = teamEntity(
            { id: m.awayTeam.id, name: m.awayTeam.name, shortName: m.awayTeam.shortName ?? null, tla: null },
            s,
          );
          const date = m.utcDate.slice(0, 10);
          const seasonSnap = (s.payload as { filters?: { season?: string } }).filters?.season;
          const season = m.season
            ? seasonLabel(m.season.startDate, m.season.endDate)
            : (seasonSnap ?? date.slice(0, 4));
          const id = `fd_match_${m.id}`;
          kb.entities.set(id, {
            id,
            type: 'MATCH',
            name: id,
            names: {},
            aliases: [],
            sourceRefs: { [s.sourceId]: String(m.id) },
          });
          const scope = {
            competition: d.competition.name,
            season,
            cutoff: date,
            statDefinition: 'full-time score (90 minutes + stoppage; excludes extra time/penalties)',
          };
          kb.matches.push({
            entityId: id,
            competition: d.competition.name,
            competitionCode: d.competition.code ?? String(d.competition.id),
            season,
            date,
            matchday: m.matchday ?? null,
            stage: m.stage ?? null,
            home,
            away,
            homeGoals: hg,
            awayGoals: ag,
            regular: (m.score.duration ?? 'REGULAR') === 'REGULAR',
            factIds: {
              date: fact(id, 'date', date, scope, s),
              score: fact(id, 'full_time_score', `${hg}-${ag}`, scope, s),
              home: fact(id, 'home_team', home, scope, s),
              away: fact(id, 'away_team', away, scope, s),
              matchday: m.matchday ? fact(id, 'matchday', m.matchday, scope, s) : null,
            },
          });
        }
      }
    } catch (e) {
      kb.invalid.push({ snapshotId: s.id, error: e instanceof Error ? e.message.slice(0, 200) : 'invalid' });
    }
  }
  return kb;
}

// ---------------------------------------------------------------- question generation
const fp = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const ok = (gate: GateResult['gate'], message: string): GateResult => ({
  gate,
  passed: true,
  failureStatus: null,
  message,
});
const fail = (
  gate: GateResult['gate'],
  status: GateResult['failureStatus'],
  message: string,
): GateResult => ({ gate, passed: false, failureStatus: status, message });
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

export interface FdGenOptions {
  seed?: number;
  /** Per competition-season sample sizes for match-based templates. */
  perSeason?: { score: number; timeline: number; guess: number };
  today: string;
}

export function generateFootballDataCandidates(kb: FdKB, o: FdGenOptions): Candidate[] {
  const rng = createRng(o.seed ?? 11);
  const per = o.perSeason ?? { score: 12, timeline: 8, guess: 8 };
  const out: Candidate[] = [];
  const name = (id: string) => kb.teams.get(id)?.name ?? kb.entities.get(id)?.name ?? id;
  const aliases = (id: string) => kb.entities.get(id)?.aliases ?? [];
  const age = (d: string) => clamp(((Number(o.today.slice(0, 4)) - Number(d.slice(0, 4))) / 10) * 100);

  // ---- final tables (complete league seasons only)
  const awardedWarning = (t: FdTable, teams: string[]): GateResult[] => {
    const hit = teams.filter((x) => t.awardedTeams.includes(x));
    return hit.length
      ? [
          fail(
            'TRUTH',
            'NEEDS_REVIEW',
            `Season includes an awarded (off-the-pitch) result for ${hit.map(name).join(', ')}: confirm table values with the official league table`,
          ),
        ]
      : [];
  };
  for (const t of kb.tables.filter((x) => x.complete && x.rows.length >= 4)) {
    const rows = [...t.rows].sort((a, b) => a.position - b.position);
    const champ = rows[0]!;
    const distract = rows.slice(1, 4);
    const uniqueTop = rows.filter((r) => r.position === 1).length === 1;
    const opts = shuffle([champ, ...distract], rng);
    const options = opts.map((r, i) => ({ id: `o${i + 1}`, label: name(r.team) }));
    out.push({
      kind: 'mcq',
      template: 'fd.mcq.champion',
      item: {
        kind: 'mcq',
        prompt: `Who finished top of the ${t.competition} table in ${t.season}?`,
        options,
        correctOptionId: options[opts.indexOf(champ)]!.id,
        explanation: `${name(champ.team)} finished 1st with ${champ.points} points.`,
      },
      factIds: opts.map((r) => r.factIds.position),
      entityIds: opts.map((r) => r.team),
      fingerprint: fp(['fd_champion', t.competitionCode, t.season]),
      validators: [
        uniqueTop && new Set(options.map((x) => x.label)).size === 4
          ? ok('DISTRACTORS', '4 real clubs from the same table; exactly one finished 1st')
          : fail('DISTRACTORS', 'REJECTED', 'Ambiguous first place or duplicate clubs'),
        ...awardedWarning(
          t,
          opts.map((r) => r.team),
        ),
      ],
      components: {
        rarity: 20,
        complexity: 20,
        distractorSimilarity: 50,
        temporalDistance: age(t.cutoff),
        recallDepth: 30,
      },
      secretStrings: [],
      preRevealText: [],
    });
    // Higher or Lower on points and goals scored (same table, same definition, unequal values)
    const pool = shuffle(rows, rng);
    for (let k = 0; k + 1 < pool.length && k < 12; k += 2) {
      const [a, b] = [pool[k]!, pool[k + 1]!];
      for (const stat of ['points', 'goalsFor'] as const) {
        out.push({
          kind: 'higher_lower',
          template: `fd.hl.${stat}`,
          item: {
            kind: 'higher_lower',
            statLabel: stat === 'points' ? 'League points' : 'League goals scored',
            scope: `${t.competition} ${t.season}, final regular-season table`,
            unit: stat === 'points' ? 'pts' : 'goals',
            a: { label: name(a.team), value: a[stat] },
            b: { label: name(b.team), value: b[stat] },
          },
          factIds: [a.factIds[stat], b.factIds[stat]],
          entityIds: [a.team, b.team],
          fingerprint: fp(['fd_hl', stat, t.competitionCode, t.season, [a.team, b.team].sort()]),
          validators: [
            a[stat] !== b[stat]
              ? ok('MODE_VALIDATOR', 'Same table and definition; unequal values')
              : fail('MODE_VALIDATOR', 'REJECTED', 'Equal values cannot be compared'),
            ...awardedWarning(t, [a.team, b.team]),
          ],
          components: {
            rarity: 50,
            complexity: 30,
            distractorSimilarity: clamp(100 - Math.abs(a[stat] - b[stat]) * 5),
            temporalDistance: age(t.cutoff),
            recallDepth: 60,
          },
          secretStrings: [],
          preRevealText: [],
        });
      }
    }
  }

  // ---- home venues (from the teams resource)
  const venueTeams = [...kb.teams.values()].filter((t) => t.venue && t.venueFactId);
  const venueCount = new Map<string, number>();
  for (const t of venueTeams) venueCount.set(t.venue!, (venueCount.get(t.venue!) ?? 0) + 1);
  for (const t of venueTeams) {
    const unique = venueCount.get(t.venue!) === 1;
    out.push({
      kind: 'short_answer',
      template: 'fd.sa.club_by_venue',
      item: {
        kind: 'short_answer',
        prompt: `Which club plays its home matches at ${t.venue}?`,
        answer: t.name,
        aliases: aliases(t.entityId),
        explanation: `${t.venue} is the home ground of ${t.name}.`,
      },
      factIds: [t.venueFactId!],
      entityIds: [t.entityId],
      fingerprint: fp(['fd_venue_sa', t.entityId]),
      validators: [
        fail(
          'CLUES',
          'NEEDS_REVIEW',
          'Stadium names in this source can be outdated (renames/sponsorship): confirm the current official name before approving',
        ),

        unique
          ? ok('MODE_VALIDATOR', 'Venue belongs to exactly one club in the data')
          : fail('MODE_VALIDATOR', 'REJECTED', 'Venue shared by several clubs'),
      ],
      components: {
        rarity: 35,
        complexity: 20,
        distractorSimilarity: 0,
        temporalDistance: 0,
        recallDepth: 40,
      },
      secretStrings: [],
      preRevealText: [],
    });
    const others = shuffle(
      venueTeams.filter((x) => x.entityId !== t.entityId && x.venue !== t.venue),
      rng,
    ).slice(0, 3);
    if (others.length === 3 && unique) {
      const opts = shuffle([t, ...others], rng);
      const options = opts.map((x, i) => ({ id: `o${i + 1}`, label: x.venue! }));
      out.push({
        kind: 'mcq',
        template: 'fd.mcq.home_venue',
        item: {
          kind: 'mcq',
          prompt: `Which ground is home to ${t.name}?`,
          options,
          correctOptionId: options[opts.indexOf(t)]!.id,
          explanation: `${t.name} play at ${t.venue}.`,
        },
        factIds: opts.map((x) => x.venueFactId!),
        entityIds: opts.map((x) => x.entityId),
        fingerprint: fp(['fd_venue_mcq', t.entityId]),
        validators: [
          fail(
            'CLUES',
            'NEEDS_REVIEW',
            'Stadium names in this source can be outdated (renames/sponsorship): confirm the current official name before approving',
          ),

          new Set(options.map((x) => x.label)).size === 4
            ? ok('DISTRACTORS', 'Each option is the ground of exactly one club')
            : fail('DISTRACTORS', 'REJECTED', 'Duplicate grounds'),
        ],
        components: {
          rarity: 35,
          complexity: 15,
          distractorSimilarity: 30,
          temporalDistance: 0,
          recallDepth: 30,
        },
        secretStrings: [],
        preRevealText: [],
      });
    }
  }

  // ---- matches (FINISHED only)
  const label = (m: FdMatch) => `${name(m.home)} ${m.homeGoals}–${m.awayGoals} ${name(m.away)}`;
  const labelCount = new Map<string, number>();
  for (const m of kb.matches) labelCount.set(label(m), (labelCount.get(label(m)) ?? 0) + 1);
  const bySeason = new Map<string, FdMatch[]>();
  for (const m of kb.matches) {
    const k = `${m.competitionCode}|${m.season}`;
    bySeason.set(k, [...(bySeason.get(k) ?? []), m]);
  }
  for (const list of bySeason.values()) {
    for (const m of shuffle(
      list.filter((x) => x.regular),
      rng,
    ).slice(0, per.score)) {
      const actual = `${m.homeGoals}–${m.awayGoals}`;
      const variants = new Set([actual]);
      for (const [h, a] of shuffle(
        [
          [m.homeGoals + 1, m.awayGoals],
          [m.homeGoals, m.awayGoals + 1],
          [m.awayGoals, m.homeGoals],
          [Math.max(0, m.homeGoals - 1), m.awayGoals],
          [m.homeGoals + 1, m.awayGoals + 1],
        ],
        rng,
      ))
        if (variants.size < 4) variants.add(`${h}–${a}`);
      const opts = shuffle([...variants], rng);
      const options = opts.map((l, i) => ({ id: `o${i + 1}`, label: l }));
      out.push({
        kind: 'mcq',
        template: 'fd.mcq.match_score',
        item: {
          kind: 'mcq',
          prompt: `${m.competition} ${m.season}: what was the full-time score when ${name(m.home)} hosted ${name(m.away)} on ${m.date}?`,
          options,
          correctOptionId: options[opts.indexOf(actual)]!.id,
          explanation: `${label(m)} (${m.date}).`,
        },
        factIds: [m.factIds.date, m.factIds.score, m.factIds.home, m.factIds.away],
        entityIds: [m.entityId, m.home, m.away],
        fingerprint: fp(['fd_score', m.entityId]),
        validators: [
          variants.size === 4
            ? ok('DISTRACTORS', '4 distinct scorelines; exactly one is the recorded full-time score')
            : fail('DISTRACTORS', 'REJECTED', 'Not enough distinct scorelines'),
        ],
        components: {
          rarity: 80,
          complexity: 30,
          distractorSimilarity: 80,
          temporalDistance: age(m.date),
          recallDepth: 80,
        },
        secretStrings: [],
        preRevealText: [],
      });
    }
    const pool = shuffle(list, rng);
    for (let k = 0; k + 1 < pool.length && k < per.timeline * 2; k += 2) {
      const [x, y] = [pool[k]!, pool[k + 1]!];
      const gap = Math.abs(Date.parse(x.date) - Date.parse(y.date)) / 86400000;
      const earlier = x.date < y.date ? x : y;
      const unique = labelCount.get(label(x)) === 1 && labelCount.get(label(y)) === 1;
      out.push({
        kind: 'timeline',
        template: 'fd.tl.match_order',
        item: {
          kind: 'timeline',
          prompt: `${x.competition}: which of these matches was played first?`,
          events: [
            { id: 'e1', label: label(x), date: x.date },
            { id: 'e2', label: label(y), date: y.date },
          ],
          earlierId: earlier === x ? 'e1' : 'e2',
        },
        factIds: [x.factIds.date, x.factIds.score, y.factIds.date, y.factIds.score],
        entityIds: [x.entityId, y.entityId],
        fingerprint: fp(['fd_tl', [x.entityId, y.entityId].sort()]),
        validators: [
          gap >= 14
            ? ok('MODE_VALIDATOR', 'Dates at least 14 days apart')
            : fail('MODE_VALIDATOR', 'REJECTED', 'Events too close together'),
          unique
            ? ok('IDENTITY', 'Each label identifies exactly one match')
            : fail('IDENTITY', 'REJECTED', 'Label matches several matches'),
        ],
        components: {
          rarity: 75,
          complexity: 50,
          distractorSimilarity: clamp(100 - gap / 3),
          temporalDistance: age(earlier.date),
          recallDepth: 70,
        },
        secretStrings: [x.date, y.date],
        preRevealText: [label(x), label(y)],
      });
    }
    for (const m of shuffle(
      list.filter((x) => x.matchday !== null),
      rng,
    ).slice(0, per.guess)) {
      const others = shuffle(
        list.filter((x) => x.entityId !== m.entityId),
        rng,
      ).slice(0, 3);
      if (others.length < 3) continue;
      const opts = shuffle([m, ...others], rng);
      const options = opts.map((x, i) => ({ id: `o${i + 1}`, label: `${name(x.home)} vs ${name(x.away)}` }));
      const fits = (x: FdMatch) =>
        x.matchday === m.matchday && x.homeGoals === m.homeGoals && x.awayGoals === m.awayGoals;
      out.push({
        kind: 'guess_match',
        template: 'fd.gm.fixture',
        item: {
          kind: 'guess_match',
          options,
          correctOptionId: options[opts.indexOf(m)]!.id,
          clues: [
            `${m.competition} ${m.season}`,
            `Matchday ${m.matchday}`,
            `Full-time score ${m.homeGoals}–${m.awayGoals}`,
          ],
        },
        factIds: opts.flatMap((x) => [x.factIds.score, ...(x.factIds.matchday ? [x.factIds.matchday] : [])]),
        entityIds: opts.map((x) => x.entityId),
        fingerprint: fp(['fd_gm', m.entityId]),
        validators: [
          opts.filter(fits).length === 1
            ? ok('DISTRACTORS', 'Real matches from the same season; exactly one fits every clue')
            : fail('DISTRACTORS', 'REJECTED', 'A distractor fits the full clue sequence'),
          new Set(options.map((x) => x.label)).size === 4
            ? ok('IDENTITY', 'Distinct fixtures')
            : fail('IDENTITY', 'REJECTED', 'Duplicate fixture labels'),
        ],
        components: {
          rarity: 70,
          complexity: 60,
          distractorSimilarity: 60,
          temporalDistance: age(m.date),
          recallDepth: 70,
        },
        secretStrings: [],
        preRevealText: options.map((x) => x.label),
      });
    }
  }
  return out;
}
