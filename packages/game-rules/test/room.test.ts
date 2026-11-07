import { describe, expect, it } from 'vitest';
import type { ContentItem, ModeKey } from '@ft/shared';
import {
  advance, createRoom, DEFAULT_TIMING as T, engineFor, gameNow, project, reduce, replay, type RoomEvent, type RoomState,
} from '../src/index.js';
import { hl, gm, mcq } from './fixtures.js';

class Sim {
  events: RoomEvent[] = [];
  s: RoomState;
  t = 0;
  constructor() {
    const e: RoomEvent = { type: 'create', at: 0, roomId: 'r1', code: 'ABCDEF', seed: 99, timing: T, memberId: 'h', name: 'Host' };
    this.events.push(e);
    this.s = createRoom(e);
  }
  push(e: RoomEvent) {
    this.events.push(e);
    this.s = reduce(this.s, e);
    return this;
  }
  at(t: number) {
    this.t = t;
    return this;
  }
  join(id: string, role: 'PLAYER' | 'JUDGE' | 'SPECTATOR' = 'PLAYER') {
    return this.push({ type: 'join', at: this.t, memberId: id, name: id.toUpperCase(), role });
  }
  cmd(actorId: string, command: any) {
    return this.push({ type: 'cmd', at: this.t, actorId, command });
  }
  tick(t: number) {
    this.t = t;
    return this.push({ type: 'tick', at: t });
  }
  try(fn: () => unknown): string {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return (e as Error).message;
    }
  }
  configure(modes: ModeKey[], preset = modes.length === 1 ? 'SINGLE' : 'CUSTOM') {
    return this.cmd('h', { type: 'room.configure', payload: { preset, modes } });
  }
  readyAll() {
    for (const m of this.s.members.filter((x) => x.role === 'PLAYER' && !x.left)) this.cmd(m.id, { type: 'room.ready', payload: { ready: true } });
    return this;
  }
  start(content: ContentItem[][], tiebreak = Array.from({ length: 5 }, (_, i) => mcq(100 + i))) {
    return this.push({ type: 'start', at: this.t, actorId: 'h', content, tiebreakContent: tiebreak });
  }
  view(id: string | null, role: any = 'PLAYER') {
    return project(this.s, { memberId: id, role }, this.t);
  }
  run() {
    return this.s.matchNight!.run!;
  }
  /** Advance game until the engine reaches given phase predicate */
  skipIntro() {
    return this.tick(this.t + T.modeIntro);
  }
}

const HL = [hl(0, 1, 2), hl(1, 2, 1), hl(2, 1, 2), hl(3, 2, 1), hl(4, 1, 2)];
const GM = Array.from({ length: 8 }, (_, i) => gm(i));

describe('room lifecycle', () => {
  it('2–6 players; 7th player rejected; spectators unlimited; joins after start only as spectator', () => {
    const r = new Sim();
    for (const id of ['b', 'c', 'd', 'e', 'f']) r.join(id);
    expect(r.try(() => r.join('g'))).toMatch(/6 players/);
    for (let i = 0; i < 50; i++) r.join(`s${i}`, 'SPECTATOR');
    expect(r.view('h').spectatorCount).toBe(50);
    r.configure(['higher_lower']).readyAll().start([HL]);
    expect(r.s.status).toBe('IN_PROGRESS');
    expect(r.try(() => r.join('late'))).toMatch(/spectator/);
    r.join('late2', 'SPECTATOR');
  });

  it('cannot start with 1 player, unready players, blocked modes or missing judge', () => {
    const r = new Sim();
    expect(r.view('h').startIssues.join()).toMatch(/at least 2/);
    r.join('b');
    expect(r.try(() => r.configure(['who_am_i']))).toMatch(/not playable/);
    expect(r.try(() => r.cmd('h', { type: 'room.configure', payload: { preset: 'MARATHON', modes: ['higher_lower'] } }))).toMatch(/exactly 12/);
    r.configure(['buzzer']);
    expect(r.view('h').startIssues.join()).toMatch(/neutral judge/);
    r.configure(['impostor']);
    expect(r.view('h').startIssues.join()).toMatch(/3\+ players/);
    r.configure(['higher_lower']);
    expect(r.try(() => r.start([HL]))).toMatch(/Waiting for/);
    expect(r.try(() => r.cmd('b', { type: 'room.configure', payload: { preset: 'SINGLE', modes: ['timeline'] } }))).toMatch(/Only the host/);
  });

  it('ready check resets ready flags; a new player returns the room to the lobby', () => {
    const r = new Sim().join('b').readyAll();
    r.cmd('h', { type: 'room.readyCheck', payload: {} });
    expect(r.s.status).toBe('READY_CHECK');
    expect(r.s.members.every((m) => !m.ready)).toBe(true);
    r.join('c');
    expect(r.s.status).toBe('LOBBY');
  });

  it('lobby disconnect beyond 30s grace removes the member; reconnect within grace keeps them', () => {
    const r = new Sim().join('b').join('c');
    r.at(1000).push({ type: 'disconnect', at: 1000, memberId: 'b' });
    r.at(20000).push({ type: 'connect', at: 20000, memberId: 'b' });
    r.at(21000).push({ type: 'disconnect', at: 21000, memberId: 'c' });
    r.tick(21000 + T.reconnectGrace);
    expect(r.s.members.find((m) => m.id === 'b')!.left).toBe(false);
    expect(r.s.members.find((m) => m.id === 'c')!.left).toBe(true);
  });
});

describe('host migration', () => {
  it('after 30s grace transfers to co-host (in game), original host does not regain host', () => {
    const r = new Sim().join('b').join('c');
    r.cmd('h', { type: 'room.configure', payload: { preset: 'SINGLE', modes: ['higher_lower'], coHostId: 'c' } });
    r.readyAll().start([HL]);
    r.at(100).push({ type: 'disconnect', at: 100, memberId: 'h' });
    r.tick(100 + T.reconnectGrace - 1);
    expect(r.s.hostId).toBe('h');
    r.tick(100 + T.reconnectGrace);
    expect(r.s.hostId).toBe('c');
    r.at(40000).push({ type: 'connect', at: 40000, memberId: 'h' });
    expect(r.s.hostId).toBe('c');
    expect(r.s.audit.some((a) => a.action === 'host.transferred' && a.detail.to === 'c')).toBe(true);
  });
  it('without co-host: longest-present connected player; reconnect inside grace cancels transfer', () => {
    const r = new Sim().at(5).join('b').at(6).join('c');
    r.at(100).push({ type: 'disconnect', at: 100, memberId: 'h' });
    r.at(200).push({ type: 'connect', at: 200, memberId: 'h' });
    r.tick(100 + T.reconnectGrace + 5);
    expect(r.s.hostId).toBe('h');
    r.at(40_000).push({ type: 'disconnect', at: 40_000, memberId: 'b' });
    r.at(40_100).push({ type: 'disconnect', at: 40_100, memberId: 'h' });
    r.tick(40_100 + T.reconnectGrace);
    expect(r.s.hostId).toBe('c');
  });
  it('no eligible successor suspends the room; a returning player unsuspends it', () => {
    const r = new Sim().join('b');
    r.at(10).push({ type: 'disconnect', at: 10, memberId: 'b' });
    r.at(11).push({ type: 'disconnect', at: 11, memberId: 'h' });
    // b is removed at 10+30s (lobby), host grace ends at 11+30s
    r.tick(11 + T.reconnectGrace);
    expect(r.s.status).toBe('SUSPENDED');
    r.at(50000).push({ type: 'connect', at: 50000, memberId: 'h' });
    expect(r.s.status).toBe('LOBBY');
  });
  it('host leaving explicitly transfers immediately; non-host cannot transfer host', () => {
    const r = new Sim().join('b');
    expect(r.try(() => r.cmd('b', { type: 'room.transferHost', payload: { toMemberId: 'b' } }))).toMatch(/Only the host/);
    r.cmd('h', { type: 'room.leave', payload: {} });
    expect(r.s.hostId).toBe('b');
  });
});

function playHL(r: Sim, answers: Record<string, string[]>) {
  r.skipIntro();
  for (let guard = 0; guard < 50 && r.s.matchNight!.phase === 'PLAYING'; guard++) {
    const st = r.run().state as any;
    if (st.phase === 'QUESTION') {
      r.at(r.s.clock.frozenAccum + st.phaseStart + 500);
      for (const [m, list] of Object.entries(answers))
        if (list[st.index]) r.cmd(m, { type: 'game.action', payload: { action: { type: 'answer', choice: list[st.index] } } });
    }
    const end = (r.run().state as any).phaseEnd;
    r.tick(end === null ? r.t + 1000 : r.s.clock.frozenAccum + end);
  }
}

describe('Higher or Lower vertical slice through the room', () => {
  const right = ['HIGHER', 'LOWER', 'HIGHER', 'LOWER', 'HIGHER'];
  it('2 players complete a single-mode game; results and placement recorded', () => {
    const r = new Sim().join('b').configure(['higher_lower']).readyAll().start([HL]);
    expect(r.s.matchNight!.phase).toBe('INTRO');
    playHL(r, { h: right, b: ['LOWER', 'LOWER', 'HIGHER', 'LOWER', 'HIGHER'] });
    expect(r.s.matchNight!.phase).toBe('RESULTS');
    const res = r.s.matchNight!.results[0]!;
    expect(res.scores).toEqual({ h: '15', b: '9' }); // b: 4 correct (8) + pair (3,4)
    expect(res.placement).toEqual({ h: '5', b: '3' });
    r.tick(r.t + T.modeResults);
    expect(r.s.status).toBe('COMPLETED');
    expect(r.s.matchNight!.final!.champions).toEqual(['h']);
  });

  it('answers are rejected when paused; host pause waits for the question boundary; emergency pause needs a reason', () => {
    const r = new Sim().join('b').configure(['higher_lower']).readyAll().start([HL]);
    r.skipIntro();
    r.cmd('h', { type: 'room.pause', payload: { emergency: false } });
    expect(r.s.pause).toBeNull();
    expect(r.s.pausePending).not.toBeNull();
    const end = (r.run().state as any).phaseEnd;
    r.tick(end); // question closes -> REVEAL boundary -> pause applies
    expect(r.s.pause).not.toBeNull();
    const g = gameNow(r.s, r.t);
    r.tick(r.t + 60_000);
    expect(gameNow(r.s, r.t)).toBe(g); // clock frozen; nothing advanced
    expect((r.run().state as any).phase).toBe('REVEAL');
    r.cmd('h', { type: 'room.resume', payload: {} });
    // emergency
    expect(r.try(() => r.cmd('h', { type: 'room.pause', payload: { emergency: true } }))).toMatch(/reason/);
    expect(r.try(() => r.cmd('b', { type: 'room.pause', payload: { emergency: true, reason: 'fire alarm' } }))).toMatch(/Only the host/);
    r.cmd('h', { type: 'room.pause', payload: { emergency: true, reason: 'Player power cut' } });
    expect(r.try(() => r.cmd('b', { type: 'game.action', payload: { action: { type: 'answer', choice: 'HIGHER' } } }))).toMatch(/paused/);
    expect(r.s.audit.find((a) => a.action === 'pause.emergency')!.detail.reason).toBe('Player power cut');
    // view never reveals the answer while paused mid-question
    r.cmd('h', { type: 'room.resume', payload: {} });
  });

  it('disconnect does not extend answer time (no timer reset)', () => {
    const r = new Sim().join('b').configure(['higher_lower']).readyAll().start([HL]);
    r.skipIntro();
    const end = (r.run().state as any).phaseEnd;
    r.at(r.t + 1000).push({ type: 'disconnect', at: r.t, memberId: 'b' });
    r.at(r.t + 5000).push({ type: 'connect', at: r.t, memberId: 'b' });
    expect((r.run().state as any).phaseEnd).toBe(end);
  });
});

describe('appeals', () => {
  function toReveal(r: Sim, bAnswer: string) {
    r.skipIntro();
    r.at(r.t + 100);
    r.cmd('h', { type: 'game.action', payload: { action: { type: 'answer', choice: 'HIGHER' } } });
    r.cmd('b', { type: 'game.action', payload: { action: { type: 'answer', choice: bAnswer } } });
    expect((r.run().state as any).phase).toBe('REVEAL');
  }
  it('no neutral judge: appeal auto-voids the question for everyone (GDD §7)', () => {
    const r = new Sim().join('b').configure(['higher_lower']).readyAll().start([HL]);
    toReveal(r, 'LOWER');
    expect(r.view('b').appealWindows.length).toBe(1);
    r.cmd('b', { type: 'appeal.open', payload: { questionIndex: 0, reason: 'QUESTION_INCORRECT' } });
    expect(r.s.appeals[0]!.status).toBe('AUTO_VOIDED');
    expect(engineFor('higher_lower').scores(r.run().state)).toEqual({ h: '0', b: '0' });
    expect(r.try(() => r.cmd('b', { type: 'appeal.open', payload: { questionIndex: 0, reason: 'QUESTION_INCORRECT' } }))).toMatch(/One appeal/);
  });
  it('with a judge: freezes the clock until resolved; ACCEPT regrades; window closes after 15s', () => {
    const r = new Sim().join('b').join('j', 'JUDGE').configure(['higher_lower']).readyAll().start([HL]);
    toReveal(r, 'LOWER');
    r.at(r.t + 1000).cmd('b', { type: 'appeal.open', payload: { questionIndex: 0, reason: 'ANSWER_SHOULD_BE_ACCEPTED', note: 'stat definition' } });
    expect(r.s.clock.reasons).toContain('APPEAL');
    expect(r.view('h').appeals).toHaveLength(0);
    expect(r.view('j', 'JUDGE').appeals[0]!.canResolve).toBe(true);
    expect(r.try(() => r.cmd('h', { type: 'appeal.resolve', payload: { appealId: r.s.appeals[0]!.id, decision: 'ACCEPT', note: 'ok ok' } }))).toMatch(/neutral judge/);
    r.tick(r.t + 100_000);
    expect((r.run().state as any).phase).toBe('REVEAL'); // held
    r.cmd('j', { type: 'appeal.resolve', payload: { appealId: r.s.appeals[0]!.id, decision: 'ACCEPT', note: 'Source supports claim' } });
    expect(r.s.clock.reasons).not.toContain('APPEAL');
    expect(engineFor('higher_lower').scores(r.run().state)).toEqual({ h: '2', b: '2' });
    const closes = r.s.clock.frozenAccum + (r.run().state as any).phaseEnd;
    r.tick(closes);
    expect(r.try(() => r.cmd('h', { type: 'appeal.open', payload: { questionIndex: 0, reason: 'QUESTION_INCORRECT' } }))).toMatch(/closed/);
  });
  it('a judge who graded the answer cannot adjudicate its appeal (conflict of interest)', () => {
    const r = new Sim().join('b').join('j', 'JUDGE').configure(['connections']).readyAll();
    const items = Array.from({ length: 8 }, (_, i) => ({ kind: 'connection', meta: hl(i, 1, 2).meta, entities: ['a', 'b', 'c', 'd'], link: 'Link', aliases: [], explanation: '' }) as ContentItem);
    r.start([items]).skipIntro();
    r.at(r.t + 10).cmd('b', { type: 'game.action', payload: { action: { type: 'answer', text: 'other idea' } } });
    r.cmd('h', { type: 'game.action', payload: { action: { type: 'answer', text: 'link' } } });
    r.cmd('j', { type: 'game.action', payload: { action: { type: 'review', memberId: 'b', accept: false } } });
    r.cmd('b', { type: 'appeal.open', payload: { questionIndex: 0, reason: 'ANSWER_SHOULD_BE_ACCEPTED' } });
    // only judge is the grader -> no eligible reviewer -> auto void
    expect(r.s.appeals[0]!.status).toBe('AUTO_VOIDED');
  });
});

describe('Match Night end to end', () => {
  it('two modes, shared placements as exact fractions, ladder, tiebreak, shared champions, replay', () => {
    const r = new Sim().join('b').join('c').join('spec', 'SPECTATOR');
    r.configure(['higher_lower', 'guess_the_match'], 'CUSTOM').readyAll().start([HL, GM]);
    // HL: h perfect, b and c identical mediocre -> b,c share 2nd/3rd = 2 each
    const right = ['HIGHER', 'LOWER', 'HIGHER', 'LOWER', 'HIGHER'];
    const half = ['HIGHER', 'HIGHER', 'HIGHER', 'HIGHER', 'HIGHER'];
    playHL(r, { h: right, b: half, c: half });
    expect(r.s.matchNight!.results[0]!.placement).toEqual({ h: '5', b: '2', c: '2' });
    // spectator never sees the content or answer while question is live
    r.tick(r.t + T.modeResults);
    r.skipIntro();
    const v = JSON.stringify(r.view('spec', 'SPECTATOR'));
    expect(v).not.toContain('"correctOptionId":"m2"');
    // GM: nobody answers -> 3-way tie -> each (5+3+1)/3 = 3
    for (let q = 0; q < 8; q++) r.tick(r.s.clock.frozenAccum + ((r.run().state as any).phaseEnd ?? 0));
    r.tick(r.s.clock.frozenAccum + ((r.run().state as any).phaseEnd ?? r.t));
    let guard = 0;
    while (r.s.matchNight!.phase === 'PLAYING' && guard++ < 50) r.tick(r.t + 20_000);
    expect(r.s.matchNight!.results[1]!.placement).toEqual({ h: '3', b: '3', c: '3' });
    r.tick(r.t + T.modeResults);
    // h = 8, b = c = 5 -> h sole champion, no tiebreak
    expect(r.s.status).toBe('COMPLETED');
    expect(r.s.matchNight!.final!.champions).toEqual(['h']);
    expect(r.s.matchNight!.final!.groups).toEqual([['h'], ['b', 'c']]);
    expect(r.view('h').matchNight!.standings.map((x) => x.points)).toEqual(['8', '5', '5']);

    // Deterministic replay from the append-only event log
    const replayed = replay(r.events);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(r.s));
  });

  it('tied champions go to the tiebreak; persistent tie => shared champions', () => {
    const r = new Sim().join('b');
    r.configure(['higher_lower']).readyAll().start([HL]);
    playHL(r, { h: ['HIGHER'], b: ['HIGHER'] });
    r.tick(r.t + T.modeResults);
    expect(r.s.matchNight!.phase).toBe('TIEBREAK');
    expect([...r.view('h').matchNight!.tiebreakTied!].sort()).toEqual(['b', 'h']);
    let guard = 0;
    while (r.s.status !== 'COMPLETED' && guard++ < 50) r.tick(r.t + 30_000);
    expect(r.s.matchNight!.final!.champions.sort()).toEqual(['b', 'h']);
    expect(r.s.matchNight!.final!.tiebreakUsed).toBe(true);
  });

  it('tiebreak answer separates champions', () => {
    const r = new Sim().join('b');
    r.configure(['higher_lower']).readyAll().start([HL]);
    playHL(r, {});
    r.tick(r.t + T.modeResults);
    r.at(r.t + 100).cmd('b', { type: 'game.action', payload: { action: { type: 'answer', optionId: 'o1' } } });
    r.cmd('h', { type: 'game.action', payload: { action: { type: 'answer', optionId: 'o3' } } });
    let guard = 0;
    while (r.s.status !== 'COMPLETED' && guard++ < 10) r.tick(r.t + 20_000);
    expect(r.s.matchNight!.final!.champions).toEqual(['b']);
    expect(r.s.matchNight!.final!.groups).toEqual([['b'], ['h']]);
  });

  it('player absent beyond grace at the next mode start forfeits; incompatible modes are skipped', () => {
    const r = new Sim().join('b').join('c');
    r.configure(['higher_lower', 'guess_the_match'], 'CUSTOM').readyAll().start([HL, GM]);
    r.at(r.t + 10).push({ type: 'disconnect', at: r.t + 10, memberId: 'c' });
    playHL(r, {});
    r.tick(r.t + T.modeResults);
    expect(r.s.members.find((m) => m.id === 'c')!.forfeited).toBe(true);
    expect(r.s.matchNight!.run!.players).toEqual(['h', 'b']);
    // c keeps their HL placement points
    expect(r.s.matchNight!.results[0]!.placement.c).toBeDefined();
  });

  it('spectator projection carries no hidden payloads at any point', () => {
    const r = new Sim().join('b').join('spec', 'SPECTATOR');
    r.configure(['higher_lower']).readyAll().start([HL]).skipIntro();
    const v = JSON.stringify(r.view('spec', 'SPECTATOR'));
    expect(v).not.toMatch(/"value":2/); // B value of item 0
    expect(r.view('spec', 'SPECTATOR').me!.role).toBe('SPECTATOR');
    expect(r.try(() => r.cmd('spec', { type: 'game.action', payload: { action: { type: 'answer', choice: 'HIGHER' } } }))).toMatch(/Spectators/);
    expect(r.try(() => r.cmd('spec', { type: 'appeal.open', payload: { questionIndex: 0, reason: 'QUESTION_INCORRECT' } }))).toMatch(/Only players/);
  });

  it('advance is idempotent and time-order independent', () => {
    const r = new Sim().join('b').configure(['higher_lower']).readyAll().start([HL]);
    const a = advance(advance(r.s, 50_000), 50_000);
    const b = advance(r.s, 50_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const stepwise = [10_000, 20_000, 30_000, 50_000].reduce((s, t) => advance(s, t), r.s);
    expect(JSON.stringify(stepwise)).toBe(JSON.stringify(b));
  });
});
