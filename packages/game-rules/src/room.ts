import {
  Fraction,
  GameError,
  hashSeed,
  MODES,
  PRESET_SIZES,
  type AppealDecision,
  type AppealReason,
  type ClientCommand,
  type ContentItem,
  type McqItem,
  type ModeKey,
  type PlaylistPreset,
  type RoomRole,
} from '@ft/shared';
import { computeStandings } from './ladder.js';
import { placementShares } from './placement.js';
import { engineFor } from './registry.js';
import type { Timing } from './timing.js';
import type { Viewer } from './types.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export type RoomStatus = 'LOBBY' | 'READY_CHECK' | 'IN_PROGRESS' | 'COMPLETED' | 'SUSPENDED';
export type Preset = PlaylistPreset | 'SINGLE';

export interface Member {
  id: string;
  name: string;
  role: RoomRole;
  joinedAt: number;
  connected: boolean;
  disconnectedAt: number | null;
  ready: boolean;
  left: boolean;
  forfeited: boolean;
}

export interface Appeal {
  id: string;
  runIndex: number;
  itemIndex: number;
  claimantId: string;
  reason: AppealReason;
  note: string | null;
  filedAt: number;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'VOIDED' | 'AUTO_VOIDED';
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
  detail: number | null;
}

export interface AuditEntry {
  seq: number;
  at: number;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface ModeRun {
  key: ModeKey | 'tiebreak';
  players: string[];
  judges: string[];
  state: unknown;
}

export interface ModeResult {
  key: ModeKey;
  skipped: string | null;
  players: string[];
  scores: Record<string, string>;
  groups: string[][];
  placement: Record<string, string>;
}

export interface FinalResult {
  groups: string[][];
  champions: string[];
  standings: Array<{ memberId: string; points: string; sole1: number; sole2: number; sole3: number }>;
  tiebreakUsed: boolean;
}

export interface MatchNight {
  preset: Preset;
  modes: ModeKey[];
  index: number;
  phase: 'INTRO' | 'PLAYING' | 'RESULTS' | 'TIEBREAK' | 'FINAL';
  phaseEnd: number | null;
  run: ModeRun | null;
  results: ModeResult[];
  participants: string[];
  content: ContentItem[][];
  tiebreakContent: McqItem[];
  final: FinalResult | null;
}

export interface RoomState {
  id: string;
  code: string;
  version: number;
  status: RoomStatus;
  suspendedFrom: RoomStatus | null;
  createdAt: number;
  hostId: string;
  coHostId: string | null;
  hostGraceUntil: number | null;
  members: Member[];
  playlist: { preset: Preset; modes: ModeKey[] };
  clock: { frozenAccum: number; frozenSince: number | null; reasons: string[] };
  pause: { emergency: boolean; reason: string | null; by: string; since: number } | null;
  pausePending: { by: string; at: number } | null;
  matchNight: MatchNight | null;
  appeals: Appeal[];
  audit: AuditEntry[];
  seed: number;
  timing: Timing;
  /** Last processed event time; events must be non-decreasing in time. */
  now: number;
}

/** Events are the append-only log. Replaying them through `reduce` reconstructs state exactly. */
export type RoomEvent =
  | {
      type: 'create';
      at: number;
      roomId: string;
      code: string;
      seed: number;
      timing: Timing;
      memberId: string;
      name: string;
    }
  | { type: 'join'; at: number; memberId: string; name: string; role: RoomRole }
  | { type: 'connect'; at: number; memberId: string }
  | { type: 'disconnect'; at: number; memberId: string }
  | { type: 'tick'; at: number }
  | { type: 'start'; at: number; actorId: string; content: ContentItem[][]; tiebreakContent: McqItem[] }
  | {
      type: 'cmd';
      at: number;
      actorId: string;
      command: Exclude<
        ClientCommand,
        { type: 'room.create' | 'room.join' | 'session.resume' | 'room.start' | 'ping' }
      >;
    };

// ---------------------------------------------------------------- clock helpers

export function gameNow(s: RoomState, at: number): number {
  const c = s.clock;
  return at - c.frozenAccum - (c.frozenSince !== null ? at - c.frozenSince : 0);
}

export function isFrozen(s: RoomState): boolean {
  return s.clock.frozenSince !== null;
}

function freeze(s: RoomState, reason: string, at: number): RoomState {
  if (s.clock.reasons.includes(reason)) return s;
  return {
    ...s,
    clock: {
      ...s.clock,
      reasons: [...s.clock.reasons, reason],
      frozenSince: s.clock.frozenSince ?? at,
    },
  };
}

function unfreeze(s: RoomState, reason: string, at: number): RoomState {
  if (!s.clock.reasons.includes(reason)) return s;
  const reasons = s.clock.reasons.filter((r) => r !== reason);
  if (reasons.length > 0) return { ...s, clock: { ...s.clock, reasons } };
  const since = s.clock.frozenSince ?? at;
  return { ...s, clock: { frozenAccum: s.clock.frozenAccum + (at - since), frozenSince: null, reasons: [] } };
}

function toReal(s: RoomState, g: number): number {
  return g + s.clock.frozenAccum;
}

// ---------------------------------------------------------------- member helpers

export function activeMembers(s: RoomState): Member[] {
  return s.members.filter((m) => !m.left);
}
export function activePlayers(s: RoomState): Member[] {
  return activeMembers(s).filter((m) => m.role === 'PLAYER');
}
export function activeJudges(s: RoomState): Member[] {
  return activeMembers(s).filter((m) => m.role === 'JUDGE');
}
function member(s: RoomState, id: string): Member | undefined {
  return s.members.find((m) => m.id === id);
}
function requireMember(s: RoomState, id: string): Member {
  const m = member(s, id);
  if (!m || m.left) throw new GameError('FORBIDDEN', 'Not a member of this room');
  return m;
}
function requireHost(s: RoomState, id: string): Member {
  const m = requireMember(s, id);
  if (s.hostId !== id) throw new GameError('FORBIDDEN', 'Only the host can do that');
  return m;
}
function patchMember(s: RoomState, id: string, patch: Partial<Member>): RoomState {
  return { ...s, members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

function audit(
  s: RoomState,
  at: number,
  actor: string,
  action: string,
  detail: Record<string, unknown> = {},
): RoomState {
  return { ...s, audit: [...s.audit, { seq: s.audit.length + 1, at, actor, action, detail }] };
}

// ---------------------------------------------------------------- playlist validation

export interface PlaylistIssue {
  mode: ModeKey | null;
  message: string;
}

export function validatePlaylist(preset: Preset, modes: ModeKey[]): PlaylistIssue[] {
  const issues: PlaylistIssue[] = [];
  if (new Set(modes).size !== modes.length)
    issues.push({ mode: null, message: 'Each mode can appear only once' });
  if (preset === 'SINGLE' && modes.length !== 1)
    issues.push({ mode: null, message: 'Single mode needs exactly 1 mode' });
  if (preset === 'CUSTOM' && (modes.length < 2 || modes.length > 12))
    issues.push({ mode: null, message: 'Custom Match Night needs 2–12 modes' });
  if (preset !== 'CUSTOM' && preset !== 'SINGLE' && modes.length !== PRESET_SIZES[preset])
    issues.push({ mode: null, message: `${preset} needs exactly ${PRESET_SIZES[preset]} modes` });
  for (const k of modes) {
    if (MODES[k].rulesStatus === 'BLOCKED')
      issues.push({ mode: k, message: `${MODES[k].name.en} is not playable: rules awaiting approval` });
  }
  return issues;
}

/** Issues that block starting with the current members (player counts, judge availability). */
export function startIssues(s: RoomState): PlaylistIssue[] {
  const issues = validatePlaylist(s.playlist.preset, s.playlist.modes);
  const players = activePlayers(s);
  const judges = activeJudges(s).filter((j) => j.connected);
  if (players.length < MIN_PLAYERS)
    issues.push({ mode: null, message: `Need at least ${MIN_PLAYERS} players` });
  if (players.length > MAX_PLAYERS) issues.push({ mode: null, message: `At most ${MAX_PLAYERS} players` });
  for (const k of s.playlist.modes) {
    const info = MODES[k];
    if (players.length < info.minPlayers)
      issues.push({ mode: k, message: `${info.name.en} needs ${info.minPlayers}+ players` });
    if (info.judge === 'required' && judges.length === 0)
      issues.push({ mode: k, message: `${info.name.en} needs a neutral judge (join as Judge)` });
  }
  const notReady = players.filter((p) => !p.ready);
  if (notReady.length > 0)
    issues.push({ mode: null, message: `Waiting for ${notReady.map((p) => p.name).join(', ')} to be ready` });
  return issues;
}

// ---------------------------------------------------------------- create / reduce

export function createRoom(e: Extract<RoomEvent, { type: 'create' }>): RoomState {
  const s: RoomState = {
    id: e.roomId,
    code: e.code,
    version: 1,
    status: 'LOBBY',
    suspendedFrom: null,
    createdAt: e.at,
    hostId: e.memberId,
    coHostId: null,
    hostGraceUntil: null,
    members: [
      {
        id: e.memberId,
        name: e.name,
        role: 'PLAYER',
        joinedAt: e.at,
        connected: true,
        disconnectedAt: null,
        ready: false,
        left: false,
        forfeited: false,
      },
    ],
    playlist: {
      preset: 'CLASSIC',
      modes: ['higher_lower', 'guess_the_match', 'missing_xi', 'last_man_standing', 'timeline'],
    },
    clock: { frozenAccum: 0, frozenSince: null, reasons: [] },
    pause: null,
    pausePending: null,
    matchNight: null,
    appeals: [],
    audit: [],
    seed: e.seed,
    timing: e.timing,
    now: e.at,
  };
  return audit(s, e.at, e.memberId, 'room.created', { code: e.code });
}

export function reduce(prev: RoomState, e: RoomEvent): RoomState {
  if (e.type === 'create') throw new GameError('INVALID_STATE', 'Room already exists');
  const at = Math.max(e.at, prev.now);
  let s = advance(prev, at);
  s = apply(s, e, at);
  s = settle(s, at);
  return { ...s, version: s.version + 1, now: at };
}

function apply(s: RoomState, e: RoomEvent, at: number): RoomState {
  switch (e.type) {
    case 'tick':
      return s;
    case 'join':
      return join(s, e, at);
    case 'connect':
      return connect(s, e.memberId, at);
    case 'disconnect':
      return disconnect(s, e.memberId, at);
    case 'start':
      return start(s, e, at);
    case 'cmd':
      return command(s, e.actorId, e.command, at);
    default:
      return s;
  }
}

function join(s: RoomState, e: Extract<RoomEvent, { type: 'join' }>, at: number): RoomState {
  if (s.status === 'COMPLETED') throw new GameError('INVALID_STATE', 'This room has finished');
  if (member(s, e.memberId)) throw new GameError('DUPLICATE', 'Already joined');
  const inLobby = s.status === 'LOBBY' || s.status === 'READY_CHECK';
  if (e.role === 'PLAYER') {
    if (!inLobby) throw new GameError('INVALID_STATE', 'Game already started — join as a spectator');
    if (activePlayers(s).length >= MAX_PLAYERS)
      throw new GameError('ROOM_FULL', 'Room has 6 players — join as a spectator');
  }
  if (e.role === 'JUDGE' && !inLobby)
    throw new GameError('INVALID_STATE', 'Judges must join before the game starts');
  let n: RoomState = {
    ...s,
    members: [
      ...s.members,
      {
        id: e.memberId,
        name: e.name,
        role: e.role,
        joinedAt: at,
        connected: true,
        disconnectedAt: null,
        ready: false,
        left: false,
        forfeited: false,
      },
    ],
  };
  if (s.status === 'READY_CHECK' && e.role !== 'SPECTATOR') n = backToLobby(n);
  return audit(n, at, e.memberId, 'member.joined', { role: e.role });
}

function backToLobby(s: RoomState): RoomState {
  return { ...s, status: 'LOBBY', members: s.members.map((m) => ({ ...m, ready: false })) };
}

function connect(s: RoomState, id: string, at: number): RoomState {
  const m = requireMember(s, id);
  let n = patchMember(s, id, { connected: true, disconnectedAt: null });
  if (s.hostId === id) n = { ...n, hostGraceUntil: null };
  if (s.status === 'SUSPENDED' && m.role === 'PLAYER') {
    n = { ...n, status: s.suspendedFrom ?? 'LOBBY', suspendedFrom: null, hostId: id, hostGraceUntil: null };
    n = unfreeze(n, 'SUSPENDED', at);
    n = audit(n, at, 'SYSTEM', 'room.unsuspended', { host: id });
  }
  return audit(n, at, id, 'member.connected');
}

function disconnect(s: RoomState, id: string, at: number): RoomState {
  const m = member(s, id);
  if (!m || m.left || !m.connected) return s;
  let n = patchMember(s, id, { connected: false, disconnectedAt: at });
  if (s.hostId === id) n = { ...n, hostGraceUntil: at + s.timing.reconnectGrace };
  return audit(n, at, id, 'member.disconnected');
}

/** Host migration: connected co-host first, else longest-present connected player; else suspend. */
function migrateHost(s: RoomState, at: number, reason: string, exclude: string | null): RoomState {
  const eligible = (m: Member) =>
    !m.left && m.connected && m.role === 'PLAYER' && m.id !== exclude && m.id !== s.hostId;
  const co = s.coHostId ? s.members.find((m) => m.id === s.coHostId && eligible(m)) : undefined;
  const next = co ?? [...s.members].filter(eligible).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!next) {
    let n: RoomState = { ...s, hostGraceUntil: null };
    if (s.status !== 'COMPLETED' && s.status !== 'SUSPENDED') {
      n = { ...n, suspendedFrom: s.status, status: 'SUSPENDED' };
      n = freeze(n, 'SUSPENDED', at);
    }
    return audit(n, at, 'SYSTEM', 'room.suspended', { reason: 'No eligible host successor' });
  }
  const n = {
    ...s,
    hostId: next.id,
    hostGraceUntil: null,
    coHostId: s.coHostId === next.id ? null : s.coHostId,
  };
  return audit(n, at, 'SYSTEM', 'host.transferred', { from: s.hostId, to: next.id, reason });
}

function command(
  s: RoomState,
  actorId: string,
  c: Extract<RoomEvent, { type: 'cmd' }>['command'],
  at: number,
): RoomState {
  switch (c.type) {
    case 'room.leave': {
      const m = requireMember(s, actorId);
      let n = patchMember(s, actorId, { left: true, connected: false, ready: false });
      if (s.status === 'IN_PROGRESS' && m.role === 'PLAYER') n = patchMember(n, actorId, { forfeited: true });
      if (s.status === 'READY_CHECK' && m.role !== 'SPECTATOR') n = backToLobby(n);
      n = audit(n, at, actorId, 'member.left');
      if (s.hostId === actorId) n = migrateHost(n, at, 'host left', actorId);
      if (s.coHostId === actorId) n = { ...n, coHostId: null };
      return n;
    }
    case 'room.ready': {
      const m = requireMember(s, actorId);
      if (m.role !== 'PLAYER') throw new GameError('FORBIDDEN', 'Only players ready up');
      if (s.status !== 'LOBBY' && s.status !== 'READY_CHECK')
        throw new GameError('INVALID_STATE', 'Game already started');
      return patchMember(s, actorId, { ready: c.payload.ready });
    }
    case 'room.configure': {
      requireHost(s, actorId);
      if (s.status !== 'LOBBY' && s.status !== 'READY_CHECK')
        throw new GameError('INVALID_STATE', 'Playlist is locked once the game starts');
      const preset = c.payload.preset as Preset;
      const issues = validatePlaylist(preset, c.payload.modes);
      if (issues.length > 0) throw new GameError('RULE_VIOLATION', issues.map((i) => i.message).join('; '));
      let coHostId = s.coHostId;
      if (c.payload.coHostId !== undefined) {
        if (c.payload.coHostId !== null) {
          const co = requireMember(s, c.payload.coHostId);
          if (co.role !== 'PLAYER' || co.id === s.hostId)
            throw new GameError('RULE_VIOLATION', 'Co-host must be another player');
        }
        coHostId = c.payload.coHostId;
      }
      const n = backToLobby({ ...s, playlist: { preset, modes: [...c.payload.modes] }, coHostId });
      return audit(n, at, actorId, 'playlist.configured', { preset, modes: c.payload.modes, coHostId });
    }
    case 'room.readyCheck': {
      requireHost(s, actorId);
      if (s.status !== 'LOBBY') throw new GameError('INVALID_STATE', 'Ready check only from the lobby');
      const issues = validatePlaylist(s.playlist.preset, s.playlist.modes);
      if (issues.length) throw new GameError('RULE_VIOLATION', issues.map((i) => i.message).join('; '));
      const n = {
        ...s,
        status: 'READY_CHECK' as const,
        members: s.members.map((m) => ({ ...m, ready: false })),
      };
      return audit(n, at, actorId, 'room.readyCheck');
    }
    case 'room.transferHost': {
      requireHost(s, actorId);
      const to = requireMember(s, c.payload.toMemberId);
      if (to.role !== 'PLAYER' || !to.connected)
        throw new GameError('RULE_VIOLATION', 'Host must be a connected player');
      if (to.id === actorId) throw new GameError('RULE_VIOLATION', 'Already host');
      return audit(
        { ...s, hostId: to.id, coHostId: s.coHostId === to.id ? null : s.coHostId },
        at,
        actorId,
        'host.transferred',
        { from: actorId, to: to.id, reason: 'manual' },
      );
    }
    case 'room.kick': {
      requireHost(s, actorId);
      const target = requireMember(s, c.payload.memberId);
      if (target.id === actorId) throw new GameError('RULE_VIOLATION', 'Cannot kick yourself');
      if (s.status === 'IN_PROGRESS' && target.role !== 'SPECTATOR')
        throw new GameError(
          'RULE_VIOLATION',
          'Kicking a participant during play requires an eligible-majority vote, which is not available yet',
        );
      let n = patchMember(s, target.id, { left: true, connected: false });
      if (s.status === 'READY_CHECK') n = backToLobby(n);
      return audit(n, at, actorId, 'member.kicked', { memberId: target.id, reason: c.payload.reason });
    }
    case 'room.pause':
      return pauseCmd(s, actorId, c.payload, at);
    case 'room.resume': {
      requireHost(s, actorId);
      if (!s.pause && !s.pausePending) throw new GameError('INVALID_STATE', 'Not paused');
      if (!s.pause) return audit({ ...s, pausePending: null }, at, actorId, 'pause.cancelled');
      const n = unfreeze({ ...s, pause: null, pausePending: null }, 'PAUSE', at);
      return audit(n, at, actorId, 'pause.resumed', { durationMs: at - s.pause.since });
    }
    case 'room.nextMode': {
      requireHost(s, actorId);
      const mn = s.matchNight;
      if (!mn || (mn.phase !== 'INTRO' && mn.phase !== 'RESULTS'))
        throw new GameError('INVALID_STATE', 'Nothing to skip');
      if (isFrozen(s)) throw new GameError('INVALID_STATE', 'Game is paused');
      return phaseDeadline(s, at, actorId);
    }
    case 'game.action':
      return gameAction(s, actorId, c.payload.action, at);
    case 'appeal.open':
      return openAppeal(s, actorId, c.payload, at);
    case 'appeal.resolve':
      return resolveAppeal(s, actorId, c.payload, at);
    default:
      throw new GameError('INVALID_MESSAGE', 'Unsupported command');
  }
}

function pauseCmd(
  s: RoomState,
  actorId: string,
  p: { emergency: boolean; reason?: string | undefined },
  at: number,
): RoomState {
  requireHost(s, actorId);
  if (s.status !== 'IN_PROGRESS' || !s.matchNight || s.matchNight.phase === 'FINAL')
    throw new GameError('INVALID_STATE', 'Nothing to pause');
  if (s.pause) throw new GameError('INVALID_STATE', 'Already paused');
  if (p.emergency) {
    const reason = p.reason?.trim();
    if (!reason || reason.length < 3)
      throw new GameError('RULE_VIOLATION', 'Emergency pause requires a reason');
    const n = freeze(
      { ...s, pause: { emergency: true, reason, by: actorId, since: at }, pausePending: null },
      'PAUSE',
      at,
    );
    return audit(n, at, actorId, 'pause.emergency', { reason, gameTime: gameNow(s, at) });
  }
  if (atBoundary(s)) return doPause(s, actorId, at);
  return audit({ ...s, pausePending: { by: actorId, at } }, at, actorId, 'pause.requested');
}

function doPause(s: RoomState, by: string, at: number): RoomState {
  const n = freeze(
    { ...s, pause: { emergency: false, reason: null, by, since: at }, pausePending: null },
    'PAUSE',
    at,
  );
  return audit(n, at, by, 'pause.started', { gameTime: gameNow(s, at) });
}

function atBoundary(s: RoomState): boolean {
  const mn = s.matchNight;
  if (!mn) return false;
  if (mn.phase === 'INTRO' || mn.phase === 'RESULTS') return true;
  if (!mn.run) return false;
  return engineFor(mn.run.key).atBoundary(mn.run.state);
}

// ---------------------------------------------------------------- match night

export function validateStart(s: RoomState, actorId: string): void {
  requireHost(s, actorId);
  if (s.status !== 'LOBBY' && s.status !== 'READY_CHECK')
    throw new GameError('INVALID_STATE', 'Game already started');
  const issues = startIssues(s);
  if (issues.length) throw new GameError('RULE_VIOLATION', issues.map((i) => i.message).join('; '));
}

function start(s: RoomState, e: Extract<RoomEvent, { type: 'start' }>, at: number): RoomState {
  validateStart(s, e.actorId);
  if (e.content.length !== s.playlist.modes.length)
    throw new GameError('INTERNAL', 'Content does not match playlist');
  const participants = activePlayers(s).map((m) => m.id);
  const mn: MatchNight = {
    preset: s.playlist.preset,
    modes: [...s.playlist.modes],
    index: -1,
    phase: 'INTRO',
    phaseEnd: null,
    run: null,
    results: [],
    participants,
    content: e.content,
    tiebreakContent: e.tiebreakContent,
    final: null,
  };
  let n: RoomState = { ...s, status: 'IN_PROGRESS', matchNight: mn };
  n = audit(n, at, e.actorId, 'match.started', {
    modes: mn.modes,
    participants,
    content: e.content.map((items) => items.map((i) => `${i.meta.questionId}@v${i.meta.version}`)),
  });
  return beginMode(n, 0, at);
}

function modePlayers(s: RoomState, at: number): { players: string[]; forfeits: string[] } {
  const mn = s.matchNight!;
  const players: string[] = [];
  const forfeits: string[] = [];
  for (const id of mn.participants) {
    const m = member(s, id)!;
    // PROPOSED: absent past the 30s grace when a new mode starts => forfeit future modes.
    const absent =
      m.left ||
      (!m.connected && m.disconnectedAt !== null && at - m.disconnectedAt >= s.timing.reconnectGrace);
    if (m.forfeited || absent) forfeits.push(id);
    else players.push(id);
  }
  return { players, forfeits };
}

function beginMode(s: RoomState, index: number, at: number): RoomState {
  let n = s;
  const mn = n.matchNight!;
  if (index >= mn.modes.length) return finishMatch(n, at);
  const key = mn.modes[index]!;
  const { players, forfeits } = modePlayers(n, at);
  for (const f of forfeits) {
    if (!member(n, f)!.forfeited) {
      n = patchMember(n, f, { forfeited: true });
      n = audit(n, at, 'SYSTEM', 'player.forfeited', { memberId: f, beforeMode: key });
    }
  }
  const info = MODES[key];
  const judges = activeJudges(n)
    .filter((j) => j.connected)
    .map((j) => j.id);
  let skip: string | null = null;
  if (players.length < Math.max(MIN_PLAYERS, info.minPlayers))
    skip = `Only ${players.length} active players; ${info.name.en} needs ${Math.max(MIN_PLAYERS, info.minPlayers)}`;
  else if (info.judge === 'required' && judges.length === 0)
    skip = `${info.name.en} needs a neutral judge and none is connected`;
  if (skip) {
    const result: ModeResult = { key, skipped: skip, players, scores: {}, groups: [], placement: {} };
    n = { ...n, matchNight: { ...n.matchNight!, index, results: [...n.matchNight!.results, result] } };
    n = audit(n, at, 'SYSTEM', 'mode.skipped', { mode: key, reason: skip });
    const remainingViable = players.length >= MIN_PLAYERS;
    if (!remainingViable) return finishMatch(n, at);
    return beginMode(n, index + 1, at);
  }
  const g = gameNow(n, at);
  n = {
    ...n,
    matchNight: {
      ...n.matchNight!,
      index,
      phase: 'INTRO',
      phaseEnd: g + n.timing.modeIntro,
      run: { key, players, judges, state: null },
    },
  };
  return audit(n, at, 'SYSTEM', 'mode.intro', { mode: key, players });
}

function playMode(s: RoomState, at: number): RoomState {
  const mn = s.matchNight!;
  const run = mn.run!;
  const engine = engineFor(run.key);
  const g = gameNow(s, at);
  const items = mn.content[mn.index]!;
  const state = engine.init(
    { players: run.players, judges: run.judges, seed: hashSeed(`${s.seed}:${mn.index}`), timing: s.timing },
    items,
    g,
  );
  return { ...s, matchNight: { ...mn, phase: 'PLAYING', phaseEnd: null, run: { ...run, state } } };
}

function completeMode(s: RoomState, at: number): RoomState {
  const mn = s.matchNight!;
  const run = mn.run!;
  const engine = engineFor(run.key);
  const scores = engine.scores(run.state);
  const groups = engine.ranking(run.state);
  const placement = Object.fromEntries(
    Object.entries(placementShares(groups)).map(([k, v]) => [k, v.toString()]),
  );
  const result: ModeResult = {
    key: run.key as ModeKey,
    skipped: null,
    players: run.players,
    scores,
    groups,
    placement,
  };
  const g = gameNow(s, at);
  let n: RoomState = {
    ...s,
    matchNight: {
      ...mn,
      phase: 'RESULTS',
      phaseEnd: g + s.timing.modeResults,
      results: [...mn.results, result],
    },
  };
  n = audit(n, at, 'SYSTEM', 'mode.completed', { mode: run.key, scores, groups, placement });
  return n;
}

function finishMatch(s: RoomState, at: number): RoomState {
  const mn = s.matchNight!;
  const outcomes = mn.results.filter((r) => !r.skipped).map((r) => ({ groups: r.groups }));
  const { rows, groups } = computeStandings(mn.participants, outcomes);
  const top = groups[0] ?? [];
  const standings = rows.map((r) => ({
    memberId: r.memberId,
    points: r.points.toString(),
    sole1: r.sole1,
    sole2: r.sole2,
    sole3: r.sole3,
  }));
  if (top.length > 1 && outcomes.length > 0 && mn.tiebreakContent.length > 0) {
    const g = gameNow(s, at);
    const engine = engineFor('tiebreak');
    const state = engine.init(
      { players: top, judges: [], seed: hashSeed(`${s.seed}:tiebreak`), timing: s.timing },
      mn.tiebreakContent,
      g,
    );
    const n: RoomState = {
      ...s,
      matchNight: {
        ...mn,
        phase: 'TIEBREAK',
        phaseEnd: null,
        run: { key: 'tiebreak', players: top, judges: [], state },
        final: { groups, champions: [], standings, tiebreakUsed: true },
      },
    };
    return audit(n, at, 'SYSTEM', 'tiebreak.started', { tied: top });
  }
  return finalize(s, groups, standings, false, at);
}

function finalize(
  s: RoomState,
  groups: string[][],
  standings: FinalResult['standings'],
  tiebreakUsed: boolean,
  at: number,
): RoomState {
  const champions = groups[0] ?? [];
  const final: FinalResult = { groups, champions, standings, tiebreakUsed };
  let n: RoomState = {
    ...s,
    status: 'COMPLETED',
    matchNight: { ...s.matchNight!, phase: 'FINAL', phaseEnd: null, final },
  };
  n = unfreeze(unfreeze({ ...n, pause: null, pausePending: null }, 'PAUSE', at), 'APPEAL', at);
  return audit(n, at, 'SYSTEM', 'match.completed', { champions, groups, standings });
}

function finishTiebreak(s: RoomState, at: number): RoomState {
  const mn = s.matchNight!;
  const run = mn.run!;
  const tbGroups = engineFor('tiebreak').ranking(run.state);
  const prior = mn.final!;
  const groups = [...tbGroups, ...prior.groups.slice(1)];
  return finalize(s, groups, prior.standings, true, at);
}

/** Handles the expiry of the INTRO/RESULTS phase timers (or host skip). */
function phaseDeadline(s: RoomState, at: number, actor = 'SYSTEM'): RoomState {
  const mn = s.matchNight!;
  if (mn.phase === 'INTRO') return audit(playMode(s, at), at, actor, 'mode.started', { mode: mn.run!.key });
  if (mn.phase === 'RESULTS') return beginMode(s, mn.index + 1, at);
  return s;
}

// ---------------------------------------------------------------- game actions & appeals

function gameAction(s: RoomState, actorId: string, action: Record<string, unknown>, at: number): RoomState {
  const m = requireMember(s, actorId);
  const mn = s.matchNight;
  if (
    s.status !== 'IN_PROGRESS' ||
    !mn ||
    (mn.phase !== 'PLAYING' && mn.phase !== 'TIEBREAK') ||
    !mn.run?.state
  )
    throw new GameError('INVALID_STATE', 'No round in progress');
  if (isFrozen(s))
    throw new GameError('INVALID_STATE', s.pause ? 'Game is paused' : 'Game is on hold for an appeal');
  const run = mn.run;
  if (m.role === 'PLAYER' && !run.players.includes(actorId))
    throw new GameError('FORBIDDEN', 'You are not playing this mode');
  if (m.role === 'SPECTATOR') throw new GameError('FORBIDDEN', 'Spectators cannot act');
  if (typeof action.type !== 'string') throw new GameError('INVALID_MESSAGE', 'action.type required');
  const engine = engineFor(run.key);
  const state = engine.act(run.state, { memberId: actorId, role: m.role }, action, gameNow(s, at));
  let n: RoomState = { ...s, matchNight: { ...mn, run: { ...run, state } } };
  if (m.role === 'JUDGE') n = audit(n, at, actorId, 'judge.action', { mode: run.key, action });
  return n;
}

function eligibleAdjudicators(
  s: RoomState,
  runIndex: number,
  itemIndex: number,
  claimantId: string,
): string[] {
  const mn = s.matchNight!;
  const run = mn.run!;
  const grader =
    runIndex === mn.index || run.key === 'tiebreak'
      ? engineFor(run.key).gradedBy(run.state, itemIndex, claimantId)
      : null;
  return activeJudges(s)
    .filter((j) => j.connected && j.id !== grader && j.id !== claimantId)
    .map((j) => j.id);
}

function runIndexOf(mn: MatchNight): number {
  return mn.phase === 'TIEBREAK' ? -1 : mn.index;
}

function openAppeal(
  s: RoomState,
  actorId: string,
  p: { questionIndex: number; reason: AppealReason; note?: string | undefined },
  at: number,
): RoomState {
  const m = requireMember(s, actorId);
  if (m.role !== 'PLAYER') throw new GameError('FORBIDDEN', 'Only players can appeal');
  const mn = s.matchNight;
  if (!mn?.run?.state || (mn.phase !== 'PLAYING' && mn.phase !== 'TIEBREAK'))
    throw new GameError('INVALID_STATE', 'No appealable result');
  const engine = engineFor(mn.run.key);
  const win = engine.appealWindows(mn.run.state, gameNow(s, at)).find((w) => w.itemIndex === p.questionIndex);
  if (!win) throw new GameError('DEADLINE_PASSED', 'The 15s appeal window has closed');
  if (!win.eligible.includes(actorId)) throw new GameError('FORBIDDEN', 'You cannot appeal this result');
  const runIndex = runIndexOf(mn);
  if (
    s.appeals.some(
      (a) => a.runIndex === runIndex && a.itemIndex === p.questionIndex && a.claimantId === actorId,
    )
  )
    throw new GameError('DUPLICATE', 'One appeal per player per question');
  const appeal: Appeal = {
    id: `ap_${s.version}_${s.appeals.length + 1}`,
    runIndex,
    itemIndex: p.questionIndex,
    claimantId: actorId,
    reason: p.reason,
    note: p.note?.trim() || null,
    filedAt: at,
    status: 'PENDING',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    detail: null,
  };
  let n: RoomState = { ...s, appeals: [...s.appeals, appeal] };
  n = audit(n, at, actorId, 'appeal.opened', {
    appealId: appeal.id,
    mode: mn.run.key,
    itemIndex: p.questionIndex,
    reason: p.reason,
  });
  if (eligibleAdjudicators(n, runIndex, p.questionIndex, actorId).length === 0) {
    // GDD §7: no eligible neutral reviewer => void the disputed question; never award points arbitrarily.
    return autoVoid(n, appeal.id, at, 'No eligible neutral reviewer');
  }
  return freeze(n, 'APPEAL', at);
}

function autoVoid(s: RoomState, appealId: string, at: number, why: string): RoomState {
  const a = s.appeals.find((x) => x.id === appealId)!;
  const mn = s.matchNight!;
  let n = s;
  if (mn.run?.state && runIndexOf(mn) === a.runIndex) {
    const engine = engineFor(mn.run.key);
    const state = engine.adjudicate(mn.run.state, {
      itemIndex: a.itemIndex,
      claimantId: a.claimantId,
      decision: 'VOID',
    });
    n = { ...n, matchNight: { ...mn, run: { ...mn.run, state } } };
  }
  n = {
    ...n,
    appeals: n.appeals.map((x) =>
      x.id === appealId ? { ...x, status: 'AUTO_VOIDED' as const, decidedAt: at, decisionNote: why } : x,
    ),
  };
  n = audit(n, at, 'SYSTEM', 'appeal.autoVoided', { appealId, why });
  if (!n.appeals.some((x) => x.status === 'PENDING')) n = unfreeze(n, 'APPEAL', at);
  return n;
}

function resolveAppeal(
  s: RoomState,
  actorId: string,
  p: { appealId: string; decision: AppealDecision; note: string; detail?: number | undefined },
  at: number,
): RoomState {
  const m = requireMember(s, actorId);
  if (m.role !== 'JUDGE') throw new GameError('FORBIDDEN', 'Only a neutral judge can resolve appeals');
  const a = s.appeals.find((x) => x.id === p.appealId);
  if (!a || a.status !== 'PENDING') throw new GameError('NOT_FOUND', 'No pending appeal with that id');
  if (!eligibleAdjudicators(s, a.runIndex, a.itemIndex, a.claimantId).includes(actorId))
    throw new GameError('CONFLICT_OF_INTEREST', 'You graded this answer; another judge must review it');
  const mn = s.matchNight!;
  const engine = engineFor(mn.run!.key);
  if (!engine.supportedDecisions.includes(p.decision))
    throw new GameError('RULE_VIOLATION', 'Decision not supported in this mode');
  const state = engine.adjudicate(mn.run!.state, {
    itemIndex: a.itemIndex,
    claimantId: a.claimantId,
    decision: p.decision,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
  });
  const status = p.decision === 'ACCEPT' ? 'ACCEPTED' : p.decision === 'REJECT' ? 'REJECTED' : 'VOIDED';
  let n: RoomState = {
    ...s,
    matchNight: { ...mn, run: { ...mn.run!, state } },
    appeals: s.appeals.map((x) =>
      x.id === a.id
        ? { ...x, status, decidedBy: actorId, decidedAt: at, decisionNote: p.note, detail: p.detail ?? null }
        : x,
    ),
  };
  n = audit(n, at, actorId, 'appeal.resolved', {
    appealId: a.id,
    decision: p.decision,
    note: p.note,
    detail: p.detail ?? null,
  });
  if (!n.appeals.some((x) => x.status === 'PENDING')) n = unfreeze(n, 'APPEAL', at);
  return n;
}

// ---------------------------------------------------------------- time advance

interface Deadline {
  at: number;
  kind: 'host' | 'member' | 'phase' | 'engine' | 'appealsClose';
  ref?: string;
}

/** Earliest real-time deadline that the room must process. */
export function nextDeadline(s: RoomState): Deadline | null {
  const out: Deadline[] = [];
  if (s.hostGraceUntil !== null) out.push({ at: s.hostGraceUntil, kind: 'host' });
  const lobby = s.status === 'LOBBY' || s.status === 'READY_CHECK';
  for (const m of s.members) {
    if (m.left || m.connected || m.disconnectedAt === null) continue;
    const exp = m.disconnectedAt + s.timing.reconnectGrace;
    if (lobby || (m.role === 'JUDGE' && s.appeals.some((a) => a.status === 'PENDING')))
      out.push({ at: exp, kind: 'member', ref: m.id });
  }
  const mn = s.matchNight;
  if (mn && s.status === 'IN_PROGRESS' && !isFrozen(s)) {
    if ((mn.phase === 'INTRO' || mn.phase === 'RESULTS') && mn.phaseEnd !== null)
      out.push({ at: toReal(s, mn.phaseEnd), kind: 'phase' });
    if ((mn.phase === 'PLAYING' || mn.phase === 'TIEBREAK') && mn.run?.state) {
      const engine = engineFor(mn.run.key);
      const d = engine.nextDeadline(mn.run.state);
      if (d !== null) out.push({ at: toReal(s, d), kind: 'engine' });
      else if (engine.finished(mn.run.state)) {
        const wins = engine.appealWindows(mn.run.state, gameNow(s, s.now));
        const close = wins.length ? Math.max(...wins.map((w) => w.closesAt)) : gameNow(s, s.now);
        out.push({ at: toReal(s, close), kind: 'appealsClose' });
      }
    }
  }
  if (out.length === 0) return null;
  return out.reduce((a, b) => (b.at < a.at ? b : a));
}

export function advance(prev: RoomState, now: number): RoomState {
  let s = prev;
  for (let guard = 0; guard < 10_000; guard++) {
    const d = nextDeadline(s);
    if (!d || d.at > now) return s;
    s = processDeadline(s, d);
    s = settle(s, d.at);
  }
  throw new Error('advance(): too many deadlines (possible loop)');
}

function processDeadline(s: RoomState, d: Deadline): RoomState {
  const at = d.at;
  const withNow = { ...s, now: Math.max(s.now, at) };
  switch (d.kind) {
    case 'host':
      return migrateHost(withNow, at, 'host disconnected beyond grace', null);
    case 'member': {
      const m = member(withNow, d.ref!)!;
      let n = withNow;
      if (withNow.status === 'LOBBY' || withNow.status === 'READY_CHECK') {
        n = patchMember(n, m.id, { left: true, disconnectedAt: null });
        if (withNow.status === 'READY_CHECK' && m.role !== 'SPECTATOR') n = backToLobby(n);
        n = audit(n, at, 'SYSTEM', 'member.removed', { memberId: m.id, reason: 'disconnected beyond grace' });
      } else {
        n = patchMember(n, m.id, { disconnectedAt: null });
      }
      // A judge gone beyond grace can no longer resolve pending appeals.
      for (const a of n.appeals.filter((x) => x.status === 'PENDING')) {
        if (eligibleAdjudicators(n, a.runIndex, a.itemIndex, a.claimantId).length === 0)
          n = autoVoid(n, a.id, at, 'Judge disconnected');
      }
      return n;
    }
    case 'phase':
      return phaseDeadline(withNow, at);
    case 'engine': {
      const mn = withNow.matchNight!;
      const run = mn.run!;
      const engine = engineFor(run.key);
      const state = engine.step(run.state, gameNow(withNow, at));
      return { ...withNow, matchNight: { ...mn, run: { ...run, state } } };
    }
    case 'appealsClose':
      return withNow.matchNight!.phase === 'TIEBREAK'
        ? finishTiebreak(withNow, at)
        : completeMode(withNow, at);
  }
}

/** Post-transition checks: deferred host pause and immediate mode completion. */
function settle(s: RoomState, at: number): RoomState {
  let n = s;
  if (n.pausePending && !n.pause && atBoundary(n)) n = doPause(n, n.pausePending.by, at);
  return n;
}

// ---------------------------------------------------------------- projection

export interface ProjectedAppeal {
  id: string;
  itemIndex: number;
  claimantId: string;
  reason: AppealReason;
  note: string | null;
  status: Appeal['status'];
  decisionNote: string | null;
  canResolve: boolean;
  mine: boolean;
}

/**
 * Builds the view for one viewer. This is the ONLY data sent to clients. Engine views apply
 * per-role redaction (answers, impostor identity, votes, judge-only keys).
 */
export function project(s: RoomState, viewer: Viewer, at: number) {
  const g = gameNow(s, at);
  const mn = s.matchNight;
  const me = viewer.memberId ? member(s, viewer.memberId) : undefined;
  const run = mn?.run;
  const engine = run?.state ? engineFor(run.key) : null;
  const runIndex = mn ? runIndexOf(mn) : -2;
  const mine = viewer.memberId;
  const isJudge = me?.role === 'JUDGE';
  const appeals: ProjectedAppeal[] = s.appeals
    .filter((a) => a.runIndex === runIndex && (isJudge || a.claimantId === mine || a.status !== 'PENDING'))
    .map((a) => ({
      id: a.id,
      itemIndex: a.itemIndex,
      claimantId: a.claimantId,
      reason: a.reason,
      note: isJudge || a.claimantId === mine ? a.note : null,
      status: a.status,
      decisionNote: a.decisionNote,
      canResolve: !!(
        isJudge &&
        mine &&
        a.status === 'PENDING' &&
        mn?.run &&
        eligibleAdjudicators(s, a.runIndex, a.itemIndex, a.claimantId).includes(mine)
      ),
      mine: a.claimantId === mine,
    }));
  const windows =
    engine && run?.state && me?.role === 'PLAYER'
      ? engine
          .appealWindows(run.state, g)
          .filter(
            (w) =>
              w.eligible.includes(me.id) &&
              !s.appeals.some(
                (a) => a.runIndex === runIndex && a.itemIndex === w.itemIndex && a.claimantId === me.id,
              ),
          )
          .map((w) => ({ itemIndex: w.itemIndex, closesAt: w.closesAt }))
      : [];
  const visibleMembers = activeMembers(s).filter((m) => m.role !== 'SPECTATOR');
  return {
    room: {
      code: s.code,
      status: s.status,
      version: s.version,
      hostId: s.hostId,
      coHostId: s.coHostId,
      playlist: s.playlist,
      hostGraceUntil: s.hostGraceUntil,
    },
    me: me
      ? { memberId: me.id, role: me.role, name: me.name, isHost: s.hostId === me.id, forfeited: me.forfeited }
      : null,
    members: visibleMembers.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      connected: m.connected,
      ready: m.ready,
      forfeited: m.forfeited,
    })),
    spectatorCount: activeMembers(s).filter((m) => m.role === 'SPECTATOR').length,
    clock: { gameNow: g, frozen: isFrozen(s), reasons: s.clock.reasons },
    pause: s.pause ? { emergency: s.pause.emergency, reason: s.pause.reason, since: s.pause.since } : null,
    pausePending: !!s.pausePending,
    startIssues:
      s.status === 'LOBBY' || s.status === 'READY_CHECK' ? startIssues(s).map((i) => i.message) : [],
    matchNight: mn
      ? {
          preset: mn.preset,
          modes: mn.modes,
          index: mn.index,
          phase: mn.phase,
          phaseEnd: mn.phaseEnd,
          participants: mn.participants,
          runKey: run?.key ?? null,
          runPlayers: run?.players ?? [],
          view: engine && run?.state ? engine.view(run.state, viewer, g) : null,
          results: mn.results,
          standings: standingsView(mn),
          final: mn.final && mn.phase === 'FINAL' ? mn.final : null,
          tiebreakTied: mn.phase === 'TIEBREAK' ? (mn.final?.groups[0] ?? []) : null,
        }
      : null,
    appeals,
    appealWindows: windows,
  };
}

function standingsView(mn: MatchNight) {
  const outcomes = mn.results.filter((r) => !r.skipped).map((r) => ({ groups: r.groups }));
  const { rows } = computeStandings(mn.participants, outcomes);
  return rows.map((r) => ({
    memberId: r.memberId,
    points: r.points.toString(),
    display: r.points.toMixed(),
    sole1: r.sole1,
    sole2: r.sole2,
    sole3: r.sole3,
  }));
}

export type RoomView = ReturnType<typeof project>;

export function replay(events: RoomEvent[]): RoomState {
  const [first, ...rest] = events;
  if (!first || first.type !== 'create') throw new Error('Event log must start with create');
  let s = createRoom(first);
  for (const e of rest) {
    try {
      s = reduce(s, e);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      // Rejected commands are logged too; they must be rejected identically on replay.
    }
  }
  return s;
}

export { Fraction };
