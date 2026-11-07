import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ClientCommand, ClientEnvelope, GameError, generateInviteCode, newId, newSecretToken,
  type AckMessage, type ServerMessage,
} from '@ft/shared';
import {
  activeMembers, createRoom, nextDeadline, project, reduce, replay, validateStart,
  type RoomEvent, type RoomState, type Timing,
} from '@ft/game-rules';
import type { Persistence } from './persistence.js';
import type { ContentService } from './contentService.js';
import type { Logger } from './logger.js';
import { KeyedLimiter, TokenBucket } from './rateLimit.js';
import type { Metrics } from './metrics.js';

export interface Conn {
  id: string;
  ip: string;
  send(msg: ServerMessage): void;
  /** Sends an already-serialised message (shared across viewers with identical projections). */
  sendRaw(json: string): void;
  close(code?: number, reason?: string): void;
  roomId: string | null;
  memberId: string | null;
  bucket: TokenBucket;
}

interface Room {
  state: RoomState;
  seq: number;
  conns: Set<Conn>;
  tokens: Map<string, string>;
  idem: Map<string, AckMessage>;
  timer: NodeJS.Timeout | null;
  persisted: { audit: number; results: number; record: boolean };
  queue: Promise<void>;
  usedQuestions: Set<string>;
}

export interface ManagerOptions {
  db: Persistence;
  content: ContentService;
  log: Logger;
  metrics: Metrics;
  timing: Timing;
  secret: string;
  spectatorSoftCap: number;
  /** join/resume attempts per minute per IP (code-guessing protection) */
  joinRatePerMinute?: number;
  now?: () => number;
}

const MAX_IDEM = 2000;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private codes = new Map<string, string>();
  private joinLimiter: KeyedLimiter;
  readonly now: () => number;

  constructor(private readonly o: ManagerOptions) {
    this.now = o.now ?? Date.now;
    const rate = o.joinRatePerMinute ?? 10;
    this.joinLimiter = new KeyedLimiter(rate, rate / 60);
    o.metrics.gauge('ft_rooms_active', () => [...this.rooms.values()].filter((r) => r.state.status !== 'COMPLETED').length);
    o.metrics.gauge('ft_connections', () => [...this.rooms.values()].reduce((a, r) => a + r.conns.size, 0));
  }

  roomCount() {
    return this.rooms.size;
  }
  getRoomByCode(code: string): RoomState | undefined {
    const id = this.codes.get(code);
    return id ? this.rooms.get(id)?.state : undefined;
  }

  private hash(token: string) {
    return createHmac('sha256', this.o.secret).update(token).digest('hex');
  }

  /** Rebuilds unfinished rooms from the event log after a restart. Members start disconnected (grace applies). */
  async recover() {
    const stored = await this.o.db.loadActiveRooms();
    for (const r of stored) {
      try {
        const state = replay(r.events);
        const room = this.addRoom(state, r.events.length);
        for (const s of r.sessions) room.tokens.set(s.memberId, s.tokenHash);
        room.persisted = { audit: state.audit.length, results: state.matchNight?.results.length ?? 0, record: false };
        for (const m of activeMembers(state).filter((x) => x.connected)) this.applyEvent(room, { type: 'disconnect', at: this.now(), memberId: m.id }, null, null);
        this.o.log.info({ roomId: r.roomId, events: r.events.length }, 'room recovered from event log');
      } catch (e) {
        this.o.log.error({ err: e, roomId: r.roomId }, 'room recovery failed');
      }
    }
  }

  private addRoom(state: RoomState, seq: number): Room {
    const room: Room = { state, seq, conns: new Set(), tokens: new Map(), idem: new Map(), timer: null, persisted: { audit: 0, results: 0, record: false }, queue: Promise.resolve(), usedQuestions: new Set() };
    this.rooms.set(state.id, room);
    this.codes.set(state.code, state.id);
    return room;
  }

  handleRaw(conn: Conn, raw: string) {
    this.o.metrics.inc('ft_messages_total');
    if (raw.length > 4096) return this.reject(conn, 'unknown', 'INVALID_MESSAGE', 'Message too large');
    if (!conn.bucket.take(this.now())) {
      this.o.metrics.inc('ft_rate_limited_total');
      return this.reject(conn, 'unknown', 'RATE_LIMITED', 'Slow down');
    }
    let env: ClientEnvelope;
    try {
      env = ClientEnvelope.parse(JSON.parse(raw));
    } catch {
      return this.reject(conn, 'unknown', 'INVALID_MESSAGE', 'Malformed envelope');
    }
    const parsed = ClientCommand.safeParse(env.command);
    if (!parsed.success) return this.reject(conn, env.id, 'INVALID_MESSAGE', parsed.error.issues[0]?.message ?? 'Invalid command');
    try {
      this.dispatch(conn, env, parsed.data);
    } catch (e) {
      if (e instanceof GameError) return this.reject(conn, env.id, e.code, e.message);
      this.o.log.error({ err: e }, 'command failed');
      return this.reject(conn, env.id, 'INTERNAL', 'Internal error');
    }
  }

  private reject(conn: Conn, id: string, code: AckMessage['error'] extends infer E ? E extends { code: infer C } ? C : never : never, message: string) {
    this.o.metrics.inc('ft_commands_rejected_total', { code });
    conn.send({ t: 'ack', id, ok: false, error: { code, message } });
    void this.o.db.rejectCommand(conn.roomId, conn.memberId, id, code, message).catch(() => {});
  }

  private dispatch(conn: Conn, env: ClientEnvelope, cmd: ClientCommand) {
    if (cmd.type === 'ping') return conn.send({ t: 'pong', serverNow: this.now() });
    if (cmd.type === 'room.create' || cmd.type === 'room.join' || cmd.type === 'session.resume') {
      if (conn.roomId) throw new GameError('INVALID_STATE', 'Already in a room on this connection');
      if (!this.joinLimiter.take(conn.ip, this.now())) throw new GameError('RATE_LIMITED', 'Too many join attempts; wait a minute');
      if (cmd.type === 'room.create') return this.create(conn, env.id, cmd.payload.displayName);
      if (cmd.type === 'room.join') return this.join(conn, env.id, cmd.payload.code, cmd.payload.displayName, cmd.payload.role);
      return this.resume(conn, env.id, cmd.payload.code.toUpperCase(), cmd.payload.resumeToken);
    }
    const room = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!room || !conn.memberId) throw new GameError('UNAUTHORIZED', 'Join or resume a room first');
    const idemKey = `${conn.memberId}:${env.id}`;
    const prev = room.idem.get(idemKey);
    if (prev) return conn.send({ ...prev, duplicate: true });
    if (env.expectedVersion !== undefined && env.expectedVersion !== room.state.version && (cmd.type === 'room.configure' || cmd.type === 'room.start' || cmd.type === 'room.readyCheck'))
      throw new GameError('STALE_VERSION', 'Room changed; review and try again');
    const at = this.now();
    let event: RoomEvent;
    if (cmd.type === 'room.start') {
      validateStart(room.state, conn.memberId);
      const players = activeMembers(room.state).filter((m) => m.role === 'PLAYER').length;
      const drawn = this.o.content.drawForMatch(room.state.playlist.modes, players, room.state.seed, room.usedQuestions);
      event = { type: 'start', at, actorId: conn.memberId, content: drawn.content, tiebreakContent: drawn.tiebreak };
    } else {
      event = { type: 'cmd', at, actorId: conn.memberId, command: cmd as Extract<RoomEvent, { type: 'cmd' }>['command'] };
    }
    this.applyEvent(room, event, conn.memberId, env.id);
    const ack: AckMessage = { t: 'ack', id: env.id, ok: true };
    room.idem.set(idemKey, ack);
    if (room.idem.size > MAX_IDEM) room.idem.delete(room.idem.keys().next().value!);
    conn.send(ack);
    if (cmd.type === 'room.leave') {
      room.conns.delete(conn);
      conn.roomId = null;
      conn.memberId = null;
    }
  }

  private issueToken(room: Room, memberId: string): string {
    const token = newSecretToken();
    const h = this.hash(token);
    room.tokens.set(memberId, h);
    void room.queue.then(() => this.o.db.saveSession(room.state.id, memberId, h)).catch((err) => this.o.log.error({ err }, 'session persist failed'));
    return token;
  }

  private bind(conn: Conn, room: Room, memberId: string, id: string, token: string) {
    conn.roomId = room.state.id;
    conn.memberId = memberId;
    room.conns.add(conn);
    conn.send({ t: 'ack', id, ok: true });
    conn.send({ t: 'welcome', memberId, roomCode: room.state.code, resumeToken: token });
    this.sendState(room, conn);
  }

  private create(conn: Conn, id: string, name: string) {
    let code = generateInviteCode();
    for (let i = 0; this.codes.has(code); i++) {
      if (i > 20) throw new GameError('INTERNAL', 'Could not allocate a room code');
      code = generateInviteCode();
    }
    const memberId = newId('m');
    const e: Extract<RoomEvent, { type: 'create' }> = { type: 'create', at: this.now(), roomId: newId('room'), code, seed: randomInt(2 ** 31), timing: this.o.timing, memberId, name };
    const state = createRoom(e);
    const room = this.addRoom(state, 0);
    room.queue = room.queue.then(() => this.o.db.createRoom(state));
    this.persistEvent(room, e, memberId, id);
    this.o.metrics.inc('ft_rooms_created_total');
    this.o.log.info({ roomId: state.id, code }, 'room created');
    this.bind(conn, room, memberId, id, this.issueToken(room, memberId));
    this.schedule(room);
  }

  private join(conn: Conn, id: string, code: string, name: string, role: 'PLAYER' | 'JUDGE' | 'SPECTATOR') {
    const roomId = this.codes.get(code);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) throw new GameError('NOT_FOUND', 'No room with that code');
    if (role === 'SPECTATOR') {
      const spectators = [...room.conns].filter((c) => activeMembers(room.state).find((m) => m.id === c.memberId)?.role === 'SPECTATOR').length;
      // Infrastructure safeguard only — the product has no fixed spectator limit.
      if (spectators >= this.o.spectatorSoftCap) throw new GameError('ROOM_FULL', 'Spectator capacity temporarily reached (server safeguard). Try again shortly.');
    }
    const memberId = newId('m');
    this.applyEvent(room, { type: 'join', at: this.now(), memberId, name, role }, memberId, id);
    this.bind(conn, room, memberId, id, this.issueToken(room, memberId));
  }

  private resume(conn: Conn, id: string, code: string, token: string) {
    const roomId = this.codes.get(code);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) throw new GameError('NOT_FOUND', 'No room with that code');
    const h = Buffer.from(this.hash(token));
    const memberId = [...room.tokens.entries()].find(([, v]) => v.length === h.length && timingSafeEqual(Buffer.from(v), h))?.[0];
    if (!memberId) {
      this.o.metrics.inc('ft_resume_rejected_total');
      throw new GameError('UNAUTHORIZED', 'Resume token is invalid or was already used');
    }
    const member = room.state.members.find((m) => m.id === memberId);
    if (!member || member.left) throw new GameError('FORBIDDEN', 'You are no longer in this room');
    // One live connection per member: an older socket is closed.
    for (const c of [...room.conns]) {
      if (c.memberId === memberId) {
        c.send({ t: 'kicked', reason: 'Session resumed on another connection' });
        room.conns.delete(c);
        c.roomId = null;
        c.memberId = null;
        c.close(4000, 'replaced');
      }
    }
    const next = this.issueToken(room, memberId); // rotate: old token can never be reused
    this.applyEvent(room, { type: 'connect', at: this.now(), memberId }, memberId, id);
    this.bind(conn, room, memberId, id, next);
  }

  onClose(conn: Conn) {
    const room = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!room || !conn.memberId) return;
    room.conns.delete(conn);
    const stillConnected = [...room.conns].some((c) => c.memberId === conn.memberId);
    if (!stillConnected) {
      try {
        this.applyEvent(room, { type: 'disconnect', at: this.now(), memberId: conn.memberId }, conn.memberId, null);
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
      }
    }
  }

  /** Applies one event: reduce (throws GameError on rule violation), persist, schedule, broadcast. */
  private applyEvent(room: Room, e: RoomEvent, actor: string | null, commandId: string | null) {
    const next = reduce(room.state, e);
    room.state = next;
    this.persistEvent(room, e, actor, commandId);
    this.afterChange(room);
  }

  private persistEvent(room: Room, e: RoomEvent, actor: string | null, commandId: string | null) {
    const seq = ++room.seq;
    const s = room.state;
    const audit = s.audit.slice(room.persisted.audit);
    room.persisted.audit = s.audit.length;
    const results = s.matchNight?.results.slice(room.persisted.results) ?? [];
    const base = room.persisted.results;
    room.persisted.results += results.length;
    const final = s.matchNight?.final && s.status === 'COMPLETED' && !room.persisted.record ? s.matchNight.final : null;
    if (final) room.persisted.record = true;
    const db = this.o.db;
    room.queue = room.queue
      .then(async () => {
        await db.appendEvent(s.id, seq, e, { actor, commandId });
        await db.updateRoom(s);
        if (audit.length) await db.appendAudit(s.id, audit);
        for (const [k, r] of results.entries()) if (!r.skipped) await db.saveModeResult(s.id, base + k, r);
        if (final) await db.saveMatchRecord(s.id, final, s.matchNight!.results);
      })
      .catch((err) => {
        this.o.metrics.inc('ft_persist_errors_total');
        this.o.log.error({ err, roomId: s.id, seq }, 'persistence failed');
      });
  }

  private afterChange(room: Room) {
    // Members removed by kick get notified and unbound.
    for (const c of [...room.conns]) {
      const m = room.state.members.find((x) => x.id === c.memberId);
      if (m?.left) {
        c.send({ t: 'kicked', reason: 'You were removed from the room' });
        room.conns.delete(c);
        c.roomId = null;
        c.memberId = null;
      }
    }
    this.schedule(room);
    this.broadcast(room);
  }

  private schedule(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const d = nextDeadline(room.state);
    if (!d) return;
    const delay = Math.max(0, d.at - this.now());
    room.timer = setTimeout(() => {
      room.timer = null;
      try {
        this.applyEvent(room, { type: 'tick', at: Math.max(this.now(), d.at) }, null, null);
      } catch (err) {
        this.o.log.error({ err, roomId: room.state.id }, 'tick failed');
      }
    }, delay);
    room.timer.unref?.();
  }

  broadcast(room: Room) {
    const now = this.now();
    const cache = new Map<string, string>();
    for (const c of room.conns) {
      const m = room.state.members.find((x) => x.id === c.memberId);
      if (!m) continue;
      // Spectators share one redacted projection (fan-out optimisation, same secrecy).
      const key = m.role === 'SPECTATOR' ? 'SPECTATOR' : m.id;
      let msg = cache.get(key);
      if (!msg) {
        msg = JSON.stringify({ t: 'state', serverNow: now, view: project(room.state, { memberId: m.role === 'SPECTATOR' ? null : m.id, role: m.role }, now) });
        cache.set(key, msg);
      }
      c.sendRaw(msg);
    }
  }

  private sendState(room: Room, c: Conn) {
    const m = room.state.members.find((x) => x.id === c.memberId)!;
    const now = this.now();
    c.send({ t: 'state', serverNow: now, view: project(room.state, { memberId: m.role === 'SPECTATOR' ? null : m.id, role: m.role }, now) });
  }

  async flush() {
    await Promise.all([...this.rooms.values()].map((r) => r.queue));
  }

  shutdown() {
    for (const r of this.rooms.values()) if (r.timer) clearTimeout(r.timer);
  }

  /** Testing hook: deterministic event log of a room. */
  debugState(roomId: string) {
    return this.rooms.get(roomId)?.state;
  }
}
