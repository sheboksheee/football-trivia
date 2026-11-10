/**
 * Owner-entered kick-off line-ups (Missing XI). No free provider allows redistributing line-ups
 * (StatsBomb's user agreement forbids providing its data to third parties), so the owner types
 * famous line-ups from an official match page and cites it. Each entry is an immutable snapshot;
 * every generated question still goes through the gates and human review.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createRng, normalizeAnswer, shuffle } from '@ft/shared';
import type { Candidate } from '../generators/index.js';
import { snapshot } from '../fixture.js';
import type { Entity, Fact, GateResult, RawSnapshot } from '../model.js';
import { MANUAL_LINEUPS_SOURCE_ID } from '../sources.js';

export const POSITIONS = ['GK', 'DF', 'MF', 'FW'] as const;
export const POSITION_AR: Record<(typeof POSITIONS)[number], string> = {
  GK: 'حارس مرمى',
  DF: 'مدافع',
  MF: 'لاعب وسط',
  FW: 'مهاجم',
};

const Name = z.string().trim().min(2).max(60);
export const LineupEntry = z
  .object({
    match: z.string().trim().min(5).max(120),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    competition: z.string().trim().min(2).max(80),
    team: z.string().trim().min(2).max(60),
    formation: z.string().regex(/^\d(-\d){2,4}$/, 'Formation like 4-3-3'),
    players: z
      .array(
        z.object({
          name: Name,
          position: z.enum(POSITIONS),
          shirt: z.number().int().min(1).max(99).nullish(),
          aliases: z.array(Name).max(5).default([]),
        }),
      )
      .length(11, 'Exactly 11 starters'),
    sourceUrl: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'The source must be an https link'),
  })
  .superRefine((e, ctx) => {
    const keys = e.players.map((p) => normalizeAnswer(p.name));
    if (new Set(keys).size !== 11)
      ctx.addIssue({ code: 'custom', message: 'The 11 names must be different' });
    if (e.players.filter((p) => p.position === 'GK').length !== 1)
      ctx.addIssue({ code: 'custom', message: 'Exactly one goalkeeper' });
    const outfield = e.formation.split('-').reduce((a, b) => a + Number(b), 0);
    if (outfield !== 10)
      ctx.addIssue({ code: 'custom', message: 'Formation must add up to 10 outfield players' });
    if (e.date > new Date().toISOString().slice(0, 10))
      ctx.addIssue({ code: 'custom', message: 'The match date is in the future' });
  });
export type LineupEntry = z.infer<typeof LineupEntry>;

const Stored = z.object({ entry: LineupEntry, enteredBy: z.string() });
const Deleted = z.object({ lineupId: z.string(), deletedBy: z.string(), enteredAt: z.string() });

export const lineupId = (e: Pick<LineupEntry, 'date' | 'team' | 'match'>) =>
  createHash('sha256')
    .update(`${e.date}|${normalizeAnswer(e.team)}|${normalizeAnswer(e.match)}`)
    .digest('hex')
    .slice(0, 16);

/** Each save is a new immutable version (snapshots are never overwritten). */
export function lineupSnapshot(entry: LineupEntry, enteredBy: string, at = new Date().toISOString()) {
  return snapshot(
    MANUAL_LINEUPS_SOURCE_ID,
    'manual_lineup',
    `${lineupId(entry)}_${at.replace(/\D/g, '')}`,
    { entry, enteredBy },
    at,
  );
}
/** Tombstone for one saved version (identified by when it was entered); re-entering it later works. */
export function lineupDeletion(
  id: string,
  enteredAt: string,
  deletedBy: string,
  at = new Date().toISOString(),
) {
  return snapshot(
    MANUAL_LINEUPS_SOURCE_ID,
    'manual_lineup_deleted',
    `${id}_${enteredAt.replace(/\D/g, '')}`,
    { lineupId: id, deletedBy, enteredAt },
    at,
  );
}

export interface ManualLineup {
  id: string;
  entry: LineupEntry;
  enteredBy: string;
  enteredAt: string;
  snapshotId: string;
  factIds: string[];
  playerIds: string[];
}
export interface ManualKB {
  entities: Map<string, Entity>;
  facts: Fact[];
  factIndex: Map<string, Fact>;
  snapshots: Map<string, RawSnapshot>;
  lineups: ManualLineup[];
  invalid: Array<{ snapshotId: string; error: string }>;
}

export function normalizeManualLineups(snaps: RawSnapshot[]): ManualKB {
  const kb: ManualKB = {
    entities: new Map(),
    facts: [],
    factIndex: new Map(),
    snapshots: new Map(),
    lineups: [],
    invalid: [],
  };
  const mine = snaps.filter((s) => s.sourceId === MANUAL_LINEUPS_SOURCE_ID);
  const deleted = new Set(
    mine
      .filter((s) => s.recordType === 'manual_lineup_deleted')
      .map((s) => Deleted.safeParse(s.payload).data)
      .filter((d): d is z.infer<typeof Deleted> => !!d)
      .map((d) => `${d.lineupId}|${d.enteredAt}`),
  );
  let n = 0;
  for (const s of mine.filter((x) => x.recordType === 'manual_lineup')) {
    const p = Stored.safeParse(s.payload);
    if (!p.success) {
      kb.invalid.push({ snapshotId: s.id, error: p.error.issues[0]?.message ?? 'invalid' });
      continue;
    }
    const id = lineupId(p.data.entry);
    if (deleted.has(`${id}|${s.retrievedAt}`)) continue;
    kb.snapshots.set(s.id, s);
    const e = p.data.entry;
    const scope = {
      competition: e.competition,
      season: e.date.slice(0, 4),
      cutoff: e.date,
      statDefinition: `Kick-off XI as published at ${e.sourceUrl}`,
    };
    const lineupEntity = `ml_lineup_${id}`;
    kb.entities.set(lineupEntity, {
      id: lineupEntity,
      type: 'MATCH',
      name: `${e.match} (${e.team})`,
      names: { ar: e.match },
      aliases: [],
      sourceRefs: { [MANUAL_LINEUPS_SOURCE_ID]: id },
    });
    const factIds: string[] = [];
    const playerIds: string[] = [];
    e.players.forEach((pl, k) => {
      const pid = `ml_player_${id}_${k}`;
      kb.entities.set(pid, {
        id: pid,
        type: 'PLAYER',
        name: pl.name,
        names: {},
        aliases: pl.aliases,
        sourceRefs: { [MANUAL_LINEUPS_SOURCE_ID]: `${id}:${k}` },
      });
      const f: Fact = {
        id: `mlfact_${++n}`,
        subject: pid,
        predicate: 'kickoff_starter',
        value: `${pl.position}${pl.shirt ? `#${pl.shirt}` : ''}`,
        scope,
        sourceId: MANUAL_LINEUPS_SOURCE_ID,
        evidenceId: s.id,
        version: 1,
        status: 'ACTIVE',
      };
      kb.facts.push(f);
      kb.factIndex.set(f.id, f);
      factIds.push(f.id);
      playerIds.push(pid);
    });
    kb.lineups.push({
      id,
      entry: e,
      enteredBy: p.data.enteredBy,
      enteredAt: s.retrievedAt,
      snapshotId: s.id,
      factIds,
      playerIds,
    });
  }
  // The newest entry for the same match/team wins (an edit re-saves the line-up).
  const byId = new Map<string, ManualLineup>();
  for (const l of kb.lineups.sort((a, b) => a.enteredAt.localeCompare(b.enteredAt))) byId.set(l.id, l);
  kb.lineups = [...byId.values()];
  return kb;
}

export const manualIdPrefix = (_i: number, f: string) => `q_ml_${f.slice(0, 16)}`;

const fp = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const ok = (gate: GateResult['gate'], message: string): GateResult => ({
  gate,
  passed: true,
  failureStatus: null,
  message,
});

/** Up to `perLineup` Missing XI questions per line-up, each hiding a different outfield starter. */
export function generateManualLineupCandidates(
  kb: ManualKB,
  o: { perLineup?: number; only?: string } = {},
): Candidate[] {
  const out: Candidate[] = [];
  for (const l of kb.lineups) {
    if (o.only && l.id !== o.only) continue;
    const e = l.entry;
    const rng = createRng(Number.parseInt(l.id.slice(0, 8), 16));
    const outfield = e.players.map((_, k) => k).filter((k) => e.players[k]!.position !== 'GK');
    for (const hide of shuffle(outfield, rng).slice(0, o.perLineup ?? 4)) {
      const hidden = e.players[hide]!;
      const pos = POSITION_AR[hidden.position];
      const first = [...hidden.name.trim()][0] ?? '';
      const hints: [string, string] = [
        `بيلعب ${pos}`,
        hidden.shirt ? `لابس قميص رقم ${hidden.shirt}` : `اسمه بيبدأ بحرف «${first}»`,
      ];
      const others = e.players.filter((_, k) => k !== hide).map((p) => p.name);
      out.push({
        kind: 'missing_xi',
        template: 'ml.xi.kickoff',
        item: {
          kind: 'missing_xi',
          match: e.match,
          date: e.date,
          team: e.team,
          formation: e.formation,
          slots: e.players.map((p, k) => ({
            slot: k,
            position: p.position,
            player: k === hide ? null : p.name,
          })),
          missingAnswer: hidden.name,
          aliases: hidden.aliases,
          hints,
        },
        factIds: l.factIds,
        entityIds: [`ml_lineup_${l.id}`, ...l.playerIds],
        fingerprint: fp(['ml_xi', l.id, normalizeAnswer(hidden.name)]),
        validators: [
          ok('MODE_VALIDATOR', '11 unique starters, one goalkeeper, formation adds up (validated at entry)'),
          ok('EVIDENCE', `Owner-entered from ${e.sourceUrl} by ${l.enteredBy}`),
        ],
        components: {
          rarity: 70,
          complexity: 60,
          distractorSimilarity: 40,
          temporalDistance: Math.max(0, Math.min(100, (2026 - Number(e.date.slice(0, 4))) * 5)),
          recallDepth: 85,
        },
        secretStrings: [hidden.name, ...hidden.aliases],
        preRevealText: [...hints, ...others],
      });
    }
  }
  return out;
}
