import { describe, expect, it } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/persistence.js';
import { TestClient } from './client.js';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('PostgreSQL persistence (requires TEST_DATABASE_URL)', () => {
  it('migrations apply once and are idempotent', async () => {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    expect(await migrate(pool)).toEqual(['001_init.sql', '002_snapshot_types.sql']);
    expect(await migrate(pool)).toEqual([]);
    await pool.end();
  });

  it('persists the append-only log and recovers a room after restart; rotated token still works', async () => {
    const env = {
      DATABASE_URL: url,
      FT_TIME_SCALE: '0.02',
      LOG_LEVEL: 'silent',
      ADMIN_TOKEN: 'x'.repeat(16),
      JOIN_RATE_PER_MINUTE: '1000',
    } as NodeJS.ProcessEnv;
    const log = pino({ level: 'silent' });
    const app1 = await createApp(loadConfig(env), { log });
    const port1 = await app1.listen(0, '127.0.0.1');
    const host = await TestClient.connect(port1);
    await host.send({ type: 'room.create', payload: { displayName: 'Host', locale: 'en' } });
    await host.wait((m) => m.t === 'welcome');
    const p = await TestClient.connect(port1);
    await p.send({ type: 'room.join', payload: { code: host.code, displayName: 'P', role: 'PLAYER' } });
    await host.send({ type: 'room.ready', payload: { ready: true } });
    const version = host.view.room.version;
    await app1.manager.flush();
    const pool = new pg.Pool({ connectionString: url });
    const ev = await pool.query('SELECT type FROM room_events ORDER BY seq');
    expect(ev.rows.map((r) => r.type)).toEqual(['create', 'join', 'cmd']);
    const sess = await pool.query('SELECT token_hash FROM room_sessions');
    expect(sess.rows.every((r) => !String(r.token_hash).includes(host.token))).toBe(true); // hashed only
    const q = await pool.query("SELECT count(*)::int AS n FROM questions WHERE status='PUBLISHED'");
    expect(q.rows[0].n).toBeGreaterThan(500);
    await host.close();
    await p.close();
    await app1.close();

    const app2 = await createApp(loadConfig(env), { log });
    const port2 = await app2.listen(0, '127.0.0.1');
    const back = await TestClient.connect(port2);
    const r = await back.send({
      type: 'session.resume',
      payload: { code: host.code, resumeToken: host.token },
    });
    expect(r.ok).toBe(true);
    const v = await back.waitView(() => true);
    expect(v.me.isHost).toBe(true);
    expect(v.room.version).toBeGreaterThan(version);
    expect(v.members.find((m: any) => m.id === host.memberId).ready).toBe(true);
    await back.close();
    await app2.close();
    const audit = await pool.query("SELECT action FROM audit_events WHERE action='member.joined'");
    expect(audit.rows.length).toBe(1);
    await pool.end();
  });
});
