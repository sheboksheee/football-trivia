import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Question, SourceRecord, RawSnapshot } from '@ft/content';
import type { AuditEntry, ModeResult, FinalResult, RoomEvent, RoomState } from '@ft/game-rules';

export interface StoredRoom {
  roomId: string;
  events: RoomEvent[];
  sessions: Array<{ memberId: string; tokenHash: string }>;
}

/** Durable system of record. All writes are append-only except room status and session token rotation. */
export interface Persistence {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  createRoom(s: RoomState): Promise<void>;
  appendEvent(roomId: string, seq: number, e: RoomEvent, meta: { actor: string | null; commandId: string | null }): Promise<void>;
  updateRoom(s: RoomState): Promise<void>;
  saveSession(roomId: string, memberId: string, tokenHash: string): Promise<void>;
  appendAudit(roomId: string, entries: AuditEntry[]): Promise<void>;
  rejectCommand(roomId: string | null, memberId: string | null, commandId: string | null, code: string, message: string): Promise<void>;
  saveModeResult(roomId: string, index: number, r: ModeResult): Promise<void>;
  saveMatchRecord(roomId: string, final: FinalResult, results: ModeResult[]): Promise<void>;
  loadActiveRooms(): Promise<StoredRoom[]>;
  // content
  saveSources(s: SourceRecord[]): Promise<void>;
  saveSnapshots(s: RawSnapshot[]): Promise<void>;
  loadQuestions(): Promise<Map<string, Question>>;
  saveQuestions(q: Question[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryPersistence implements Persistence {
  readonly kind = 'memory' as const;
  rooms = new Map<string, { status: string; events: Array<{ seq: number; e: RoomEvent; commandId: string | null; actor: string | null }>; sessions: Map<string, string> }>();
  audit: Array<AuditEntry & { roomId: string }> = [];
  rejected: Array<{ code: string; message: string }> = [];
  modeResults: Array<{ roomId: string; index: number; r: ModeResult }> = [];
  matchRecords = new Map<string, FinalResult>();
  questions = new Map<string, Question>();
  async init() {}
  async createRoom(s: RoomState) {
    this.rooms.set(s.id, { status: s.status, events: [], sessions: new Map() });
  }
  async appendEvent(roomId: string, seq: number, e: RoomEvent, meta: { actor: string | null; commandId: string | null }) {
    const r = this.rooms.get(roomId)!;
    if (r.events.some((x) => x.seq === seq)) throw new Error('duplicate seq');
    if (meta.commandId && r.events.some((x) => x.commandId === meta.commandId && x.actor === meta.actor)) throw new Error('duplicate command');
    r.events.push({ seq, e, ...meta });
  }
  async updateRoom(s: RoomState) {
    const r = this.rooms.get(s.id);
    if (r) r.status = s.status;
  }
  async saveSession(roomId: string, memberId: string, tokenHash: string) {
    this.rooms.get(roomId)?.sessions.set(memberId, tokenHash);
  }
  async appendAudit(roomId: string, entries: AuditEntry[]) {
    this.audit.push(...entries.map((e) => ({ ...e, roomId })));
  }
  async rejectCommand(_r: string | null, _m: string | null, _c: string | null, code: string, message: string) {
    this.rejected.push({ code, message });
  }
  async saveModeResult(roomId: string, index: number, r: ModeResult) {
    this.modeResults.push({ roomId, index, r });
  }
  async saveMatchRecord(roomId: string, final: FinalResult) {
    this.matchRecords.set(roomId, final);
  }
  async loadActiveRooms(): Promise<StoredRoom[]> {
    return [...this.rooms.entries()]
      .filter(([, r]) => r.status !== 'COMPLETED')
      .map(([roomId, r]) => ({ roomId, events: r.events.sort((a, b) => a.seq - b.seq).map((x) => x.e), sessions: [...r.sessions].map(([memberId, tokenHash]) => ({ memberId, tokenHash })) }));
  }
  async saveSources() {}
  async saveSnapshots() {}
  async loadQuestions() {
    return new Map(this.questions);
  }
  async saveQuestions(q: Question[]) {
    for (const x of q) this.questions.set(x.id, x);
  }
  async close() {}
}

const here = dirname(fileURLToPath(import.meta.url));
export function migrationsDir(): string {
  // src/ (dev, tsx) or dist/ (bundled) both sit next to ../migrations
  return join(here, '..', 'migrations');
}

export async function migrate(pool: pg.Pool, dir = migrationsDir()): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

export class PostgresPersistence implements Persistence {
  readonly kind = 'postgres' as const;
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  async init() {
    await migrate(this.pool);
  }
  async createRoom(s: RoomState) {
    await this.pool.query('INSERT INTO rooms (id, code, status, version) VALUES ($1,$2,$3,$4)', [s.id, s.code, s.status, s.version]);
  }
  async appendEvent(roomId: string, seq: number, e: RoomEvent, meta: { actor: string | null; commandId: string | null }) {
    await this.pool.query('INSERT INTO room_events (room_id, seq, at, type, actor, command_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)', [roomId, seq, e.at, e.type, meta.actor, meta.commandId, JSON.stringify(e)]);
  }
  async updateRoom(s: RoomState) {
    await this.pool.query('UPDATE rooms SET status=$2, version=$3, updated_at=now() WHERE id=$1', [s.id, s.status, s.version]);
  }
  async saveSession(roomId: string, memberId: string, tokenHash: string) {
    await this.pool.query(
      'INSERT INTO room_sessions (room_id, member_id, token_hash) VALUES ($1,$2,$3) ON CONFLICT (room_id, member_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, issued_at=now()',
      [roomId, memberId, tokenHash],
    );
  }
  async appendAudit(roomId: string, entries: AuditEntry[]) {
    for (const a of entries)
      await this.pool.query('INSERT INTO audit_events (room_id, seq, at, actor, action, detail) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [roomId, a.seq, a.at, a.actor, a.action, JSON.stringify(a.detail)]);
  }
  async rejectCommand(roomId: string | null, memberId: string | null, commandId: string | null, code: string, message: string) {
    await this.pool.query('INSERT INTO rejected_commands (room_id, member_id, command_id, code, message) VALUES ($1,$2,$3,$4,$5)', [roomId, memberId, commandId, code, message]);
  }
  async saveModeResult(roomId: string, index: number, r: ModeResult) {
    for (const m of r.players)
      await this.pool.query(
        'INSERT INTO score_events (room_id, mode_index, mode_key, member_id, native_score, placement_points) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [roomId, index, r.key, m, r.scores[m] ?? '0', r.placement[m] ?? '0'],
      );
  }
  async saveMatchRecord(roomId: string, final: FinalResult, results: ModeResult[]) {
    await this.pool.query('INSERT INTO match_records (room_id, final, results) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [roomId, JSON.stringify(final), JSON.stringify(results)]);
  }
  async loadActiveRooms(): Promise<StoredRoom[]> {
    const rooms = await this.pool.query<{ id: string }>("SELECT id FROM rooms WHERE status <> 'COMPLETED' AND updated_at > now() - interval '1 day'");
    const out: StoredRoom[] = [];
    for (const { id } of rooms.rows) {
      const ev = await this.pool.query<{ payload: RoomEvent }>('SELECT payload FROM room_events WHERE room_id=$1 ORDER BY seq', [id]);
      const se = await this.pool.query<{ member_id: string; token_hash: string }>('SELECT member_id, token_hash FROM room_sessions WHERE room_id=$1', [id]);
      out.push({ roomId: id, events: ev.rows.map((r) => r.payload), sessions: se.rows.map((r) => ({ memberId: r.member_id, tokenHash: r.token_hash })) });
    }
    return out;
  }
  async saveSources(s: SourceRecord[]) {
    for (const x of s)
      await this.pool.query('INSERT INTO sources (id, license_status, payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET license_status=EXCLUDED.license_status, payload=EXCLUDED.payload', [x.id, x.licenseStatus, JSON.stringify(x)]);
  }
  async saveSnapshots(s: RawSnapshot[]) {
    // Immutable: insert once, never overwrite.
    const chunk = 500;
    for (let i = 0; i < s.length; i += chunk) {
      const part = s.slice(i, i + chunk);
      const values: unknown[] = [];
      const rows = part.map((x, k) => {
        values.push(x.id, x.sourceId, x.hash, x.retrievedAt, JSON.stringify(x.payload));
        const b = k * 5;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      await this.pool.query(`INSERT INTO raw_snapshots (id, source_id, hash, retrieved_at, payload) VALUES ${rows.join(',')} ON CONFLICT (id) DO NOTHING`, values);
    }
  }
  async loadQuestions() {
    const r = await this.pool.query<{ payload: Question }>('SELECT payload FROM questions');
    return new Map(r.rows.map((x) => [x.payload.id, x.payload]));
  }
  async saveQuestions(qs: Question[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const q of qs) {
        const prev = await client.query<{ n: string }>('SELECT count(*) AS n FROM question_audit WHERE question_id=$1', [q.id]);
        await client.query(
          'INSERT INTO questions (id, kind, status, version, fingerprint, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, version=EXCLUDED.version, payload=EXCLUDED.payload, updated_at=now()',
          [q.id, q.kind, q.status, q.version, q.fingerprint, JSON.stringify(q)],
        );
        for (const a of q.audit.slice(Number(prev.rows[0]?.n ?? 0)))
          await client.query('INSERT INTO question_audit (question_id, at, actor, action, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [q.id, a.at, a.actor, a.action, a.fromStatus, a.toStatus, a.note]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
