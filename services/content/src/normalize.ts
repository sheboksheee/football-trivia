import type { Entity, Fact, FactScope, RawSnapshot } from './model.js';
import { SYNTHETIC_SOURCE_ID } from './sources.js';
import { FIXTURE_COMPETITION, type FxClub, type FxMatch, type FxPlayer } from './fixture.js';

const CUTOFF = '2010-06-30';

export interface KnowledgeBase {
  entities: Map<string, Entity>;
  facts: Fact[];
  factIndex: Map<string, Fact>;
  snapshots: Map<string, RawSnapshot>;
  /** quick structured views (each element carries the fact ids that support it) */
  clubs: Array<FxClub & { factIds: string[] }>;
  players: Array<FxPlayer & { name: string; factIds: string[] }>;
  matches: Array<FxMatch & { factIds: string[] }>;
  seasonStats: Array<{
    playerId: string;
    clubId: string;
    season: number;
    goals: number;
    apps: number;
    goalsFactId: string;
    appsFactId: string;
  }>;
}

const scope = (season: number | null, statDefinition: string | null = null): FactScope => ({
  competition: FIXTURE_COMPETITION,
  season: season === null ? null : String(season),
  cutoff: CUTOFF,
  statDefinition,
});

/** Normalizes raw snapshots into canonical entities and versioned facts with evidence links. */
export function normalize(snaps: RawSnapshot[]): KnowledgeBase {
  const kb: KnowledgeBase = {
    entities: new Map(),
    facts: [],
    factIndex: new Map(),
    snapshots: new Map(),
    clubs: [],
    players: [],
    matches: [],
    seasonStats: [],
  };
  let n = 0;
  const fact = (
    subject: string,
    predicate: string,
    value: string | number,
    sc: FactScope,
    snap: RawSnapshot,
  ): string => {
    const id = `fact_${++n}`;
    const f: Fact = {
      id,
      subject,
      predicate,
      value,
      scope: sc,
      sourceId: snap.sourceId,
      evidenceId: snap.id,
      version: 1,
      status: 'ACTIVE',
    };
    kb.facts.push(f);
    kb.factIndex.set(id, f);
    return id;
  };
  const entity = (e: Entity) => {
    const prev = kb.entities.get(e.id);
    if (prev) prev.sourceRefs = { ...prev.sourceRefs, ...e.sourceRefs };
    else kb.entities.set(e.id, e);
  };
  for (const s of snaps) kb.snapshots.set(s.id, s);
  const lastNames = new Map<string, number>();
  for (const s of snaps)
    if (s.recordType === 'player') {
      const p = s.payload as FxPlayer;
      lastNames.set(p.last, (lastNames.get(p.last) ?? 0) + 1);
    }

  for (const s of snaps) {
    if (s.recordType === 'club') {
      const c = s.payload as FxClub;
      entity({
        id: c.id,
        type: 'CLUB',
        name: c.name,
        names: { en: c.name },
        aliases: [c.shortName],
        sourceRefs: { [s.sourceId]: c.id },
      });
      const ids = [
        fact(c.id, 'name', c.name, scope(null), s),
        fact(c.id, 'home_stadium', c.stadium, scope(null), s),
        fact(c.id, 'founded', c.founded, scope(null), s),
      ];
      kb.clubs.push({ ...c, factIds: ids });
    } else if (s.recordType === 'player') {
      const p = s.payload as FxPlayer;
      const name = `${p.first} ${p.last}`;
      // Alias by surname only when unique in the dataset (never merge or alias ambiguous names).
      const aliases = lastNames.get(p.last) === 1 ? [p.last] : [];
      entity({
        id: p.id,
        type: 'PLAYER',
        name,
        names: { en: name },
        aliases,
        sourceRefs: { [s.sourceId]: p.id },
      });
      const ids = [
        fact(p.id, 'position', p.position, scope(null), s),
        fact(p.id, 'nationality', p.nationality, scope(null), s),
      ];
      for (const sp of p.spells)
        ids.push(fact(p.id, 'club_spell', `${sp.clubId}:${sp.from}-${sp.to}`, scope(null), s));
      kb.players.push({ ...p, name, factIds: ids });
    } else if (s.recordType === 'match') {
      const m = s.payload as FxMatch;
      entity({
        id: m.id,
        type: 'MATCH',
        name: m.id,
        names: {},
        aliases: [],
        sourceRefs: { [s.sourceId]: m.id },
      });
      const sc = scope(m.season);
      const ids = [
        fact(m.id, 'date', m.date, sc, s),
        fact(m.id, 'home', m.homeId, sc, s),
        fact(m.id, 'away', m.awayId, sc, s),
        fact(m.id, 'score', `${m.homeGoals}-${m.awayGoals}`, sc, s),
        fact(m.id, 'venue', m.venue, sc, s),
        fact(m.id, 'matchday', m.matchday, sc, s),
      ];
      for (const [club, xi] of Object.entries(m.lineups))
        ids.push(fact(m.id, `kickoff_xi:${club}`, xi.map((x) => x.playerId).join(','), sc, s));
      kb.matches.push({ ...m, factIds: ids });
    } else if (s.recordType === 'player_season') {
      const v = s.payload as {
        playerId: string;
        clubId: string;
        season: number;
        goals: number;
        apps: number;
      };
      const def = `league goals for ${v.clubId}, all matchdays, own goals excluded`;
      const g = fact(v.playerId, `season_goals:${v.clubId}`, v.goals, scope(v.season, def), s);
      const a = fact(v.playerId, `season_apps:${v.clubId}`, v.apps, scope(v.season, 'league starts'), s);
      if (s.sourceId === SYNTHETIC_SOURCE_ID) kb.seasonStats.push({ ...v, goalsFactId: g, appsFactId: a });
    } else if (s.recordType === 'stadium_capacity') {
      const v = s.payload as { clubId: string; capacity: number };
      fact(v.clubId, 'stadium_capacity', v.capacity, scope(null, 'seated capacity'), s);
    }
  }
  return kb;
}

export interface ConflictReport {
  key: string;
  factIds: string[];
  values: Array<{ sourceId: string; value: string | number }>;
}

/**
 * Cross-source verification: facts with the same subject, predicate and scope that disagree are
 * all marked CONFLICTED. Conflicts are quarantined for human review — never auto-resolved.
 */
export function verify(kb: KnowledgeBase): ConflictReport[] {
  const groups = new Map<string, Fact[]>();
  for (const f of kb.facts) {
    const key = `${f.subject}|${f.predicate}|${f.scope.competition}|${f.scope.season}|${f.scope.statDefinition}`;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const conflicts: ConflictReport[] = [];
  for (const [key, fs] of groups) {
    // Conflict = two or more different sources reporting different values for the same scoped claim.
    // Several values from one source for a multi-valued predicate (e.g. club spells) are records, not conflicts.
    const bySource = new Map<string, Set<string>>();
    for (const f of fs)
      bySource.set(f.sourceId, (bySource.get(f.sourceId) ?? new Set()).add(String(f.value)));
    const valueSets = [...bySource.values()].map((v) => [...v].sort().join('|'));
    const sourcesDisagree = new Set(valueSets).size > 1;
    if (sourcesDisagree) {
      for (const f of fs) f.status = 'CONFLICTED';
      conflicts.push({
        key,
        factIds: fs.map((f) => f.id),
        values: fs.map((f) => ({ sourceId: f.sourceId, value: f.value })),
      });
    }
  }
  return conflicts;
}
