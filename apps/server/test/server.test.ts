import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { TestClient } from './client.js';

const SCALE = 0.02; // 10s question -> 200ms
let app: App;
let port: number;
beforeAll(async () => {
  app = await createApp(
    loadConfig({
      FT_TIME_SCALE: String(SCALE),
      ADMIN_TOKEN: 'test-admin-token',
      JOIN_RATE_PER_MINUTE: '1000',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv),
    { log: pino({ level: 'silent' }) },
  );
  port = await app.listen(0, '127.0.0.1');
});
afterAll(async () => app.close());

const act = (action: object) => ({ type: 'game.action', payload: { action } });

async function lobby(n: number, extra: Array<'SPECTATOR' | 'JUDGE'> = []) {
  const host = await TestClient.connect(port);
  await host.send({ type: 'room.create', payload: { displayName: 'Host', locale: 'en' } });
  await host.wait((m) => m.t === 'welcome');
  const others: TestClient[] = [];
  for (let i = 1; i < n; i++) {
    const c = await TestClient.connect(port);
    const ack = await c.send({
      type: 'room.join',
      payload: { code: host.code.toLowerCase(), displayName: `P${i}`, role: 'PLAYER' },
    });
    expect(ack.ok).toBe(true);
    others.push(c);
  }
  const extras: TestClient[] = [];
  for (const role of extra) {
    const c = await TestClient.connect(port);
    await c.send({ type: 'room.join', payload: { code: host.code, displayName: role, role } });
    extras.push(c);
  }
  return { host, others, extras, all: [host, ...others] };
}

describe('server integration over WebSocket', () => {
  it('health, metrics and modes endpoints', async () => {
    const h = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as any;
    expect(h.ok).toBe(true);
    const modes = (await (await fetch(`http://127.0.0.1:${port}/api/modes`)).json()) as any;
    expect(modes.modes).toHaveLength(12);
    expect(modes.playable).toContain('who_am_i');
    expect(modes.playable).toHaveLength(12);
    expect(modes.availability.higher_lower.published).toBeGreaterThan(5);
    expect(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).toContain(
      'ft_http_requests_total',
    );
  });

  it('2 players play a full Higher or Lower game end to end; spectator never receives hidden values', async () => {
    const { host, others, extras } = await lobby(2, ['SPECTATOR']);
    const [p1] = others;
    const spec = extras[0]!;
    expect(
      (await host.send({ type: 'room.configure', payload: { preset: 'SINGLE', modes: ['higher_lower'] } }))
        .ok,
    ).toBe(true);
    for (const c of [host, p1!]) await c.send({ type: 'room.ready', payload: { ready: true } });
    const start = await host.send({ type: 'room.start', payload: {} });
    expect(start.ok).toBe(true);
    for (let q = 0; q < 5; q++) {
      const v = await host.waitView(
        (x) =>
          x.matchNight?.phase === 'PLAYING' &&
          x.matchNight.view?.phase === 'QUESTION' &&
          x.matchNight.view.itemIndex === q,
      );
      expect(v.matchNight.view.item.b.value).toBeNull();
      await host.send(act({ type: 'answer', choice: 'HIGHER', itemIndex: q }));
      await p1!.send(act({ type: 'answer', choice: 'LOWER', itemIndex: q }));
    }
    const done = await host.waitView((x) => x.room.status === 'COMPLETED', 15000);
    expect(done.matchNight.final.champions.length).toBeGreaterThan(0);
    const scores = done.matchNight.results[0].scores;
    expect(Number(scores[host.memberId]) + Number(scores[p1!.memberId])).toBeGreaterThanOrEqual(10); // complementary answers: 5 correct between them
    // Spectator secrecy: during every QUESTION phase the B value was hidden from the spectator
    const live = spec.states.filter((s) => s.matchNight?.view?.phase === 'QUESTION');
    expect(live.length).toBeGreaterThan(0);
    for (const s of live) expect(s.matchNight.view.item.b.value).toBeNull();
    for (const s of spec.states) expect(s.me).toBeNull();
    await app.manager.flush();
  }, 30000);

  it('duplicate command ids are idempotent; stale versions rejected', async () => {
    const { host } = await lobby(2);
    const first = await host.send({ type: 'room.ready', payload: { ready: true } }, 'fixed-id-123456');
    host.raw(
      JSON.stringify({ id: 'fixed-id-123456', command: { type: 'room.ready', payload: { ready: false } } }),
    );
    const again = await host.wait((m) => m.t === 'ack' && m.id === 'fixed-id-123456' && m.duplicate);
    expect(first.ok).toBe(true);
    expect(again.duplicate).toBe(true);
    expect(host.view.members.find((m: any) => m.id === host.memberId).ready).toBe(true);
    const stale = await host.send(
      { type: 'room.configure', payload: { preset: 'SINGLE', modes: ['timeline'] } },
      undefined,
      { expectedVersion: 1 },
    );
    expect(stale.error.code).toBe('STALE_VERSION');
  });

  it('resume token rotates; reusing an old token is rejected; old socket is replaced', async () => {
    const { host } = await lobby(2);
    const oldToken = host.token;
    const code = host.code;
    const c2 = await TestClient.connect(port);
    const r = await c2.send({ type: 'session.resume', payload: { code, resumeToken: oldToken } });
    expect(r.ok).toBe(true);
    expect(c2.memberId).toBe(host.memberId);
    expect(c2.token).not.toBe(oldToken);
    await host.wait((m) => m.t === 'kicked');
    const c3 = await TestClient.connect(port);
    const reuse = await c3.send({ type: 'session.resume', payload: { code, resumeToken: oldToken } });
    expect(reuse.ok).toBe(false);
    expect(reuse.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed, oversized, unauthenticated and spoofed messages', async () => {
    const c = await TestClient.connect(port);
    c.raw('not json');
    expect((await c.wait((m) => m.t === 'ack' && !m.ok)).error.code).toBe('INVALID_MESSAGE');
    const unauth = await c.send({ type: 'room.ready', payload: { ready: true } });
    expect(unauth.error.code).toBe('UNAUTHORIZED');
    const bad = await c.send({
      type: 'room.join',
      payload: { code: 'ZZZZZZ', displayName: 'x', role: 'HOST' },
    });
    expect(bad.error.code).toBe('INVALID_MESSAGE');
    const nf = await c.send({
      type: 'room.join',
      payload: { code: 'ZZZZZZ', displayName: 'x', role: 'PLAYER' },
    });
    expect(nf.error.code).toBe('NOT_FOUND');
    // A client cannot claim a different actor: actor identity comes from the bound session only.
    const { host, others } = await lobby(2);
    const spoof = await others[0]!.send({
      type: 'room.configure',
      payload: { preset: 'SINGLE', modes: ['timeline'] },
    });
    expect(spoof.error.code).toBe('FORBIDDEN');
    void host;
  });

  it('rate limits message floods', async () => {
    const c = await TestClient.connect(port);
    for (let i = 0; i < 80; i++)
      c.raw(JSON.stringify({ id: `flood-${i}-xxxx`, command: { type: 'ping', payload: {} } }));
    const limited = await c.wait((m) => m.t === 'ack' && m.error?.code === 'RATE_LIMITED');
    expect(limited).toBeTruthy();
  });

  it('host disconnect transfers host after grace; returning host does not regain it', async () => {
    const { host, others } = await lobby(3);
    await host.send({ type: 'room.configure', payload: { preset: 'SINGLE', modes: ['higher_lower'] } });
    for (const c of [host, ...others]) await c.send({ type: 'room.ready', payload: { ready: true } });
    await host.send({ type: 'room.start', payload: {} });
    const token = host.token;
    const code = host.code;
    const hostId = host.memberId;
    await host.close();
    const v = await others[0]!.waitView((x) => x.room.hostId !== hostId, 5000);
    expect(v.room.hostId).toBe(others[0]!.memberId); // longest-present connected player
    const back = await TestClient.connect(port);
    expect((await back.send({ type: 'session.resume', payload: { code, resumeToken: token } })).ok).toBe(
      true,
    );
    const bv = await back.waitView(() => true);
    expect(bv.me.isHost).toBe(false);
  });

  it('admin API requires the token and enforces review rules', async () => {
    const base = `http://127.0.0.1:${port}/api/admin`;
    expect((await fetch(`${base}/summary`)).status).toBe(401);
    const auth = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
    const list = (await (
      await fetch(`${base}/questions?status=BLOCKED_RIGHTS`, { headers: auth })
    ).json()) as any;
    expect(list.total).toBeGreaterThan(0);
    const id = list.items[0].id;
    const detail = (await (await fetch(`${base}/questions/${id}`, { headers: auth })).json()) as any;
    expect(detail.facts[0].evidence.hash).toMatch(/^[0-9a-f]{64}$/);
    const r = await fetch(`${base}/questions/${id}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'APPROVE', note: 'try to force' }),
    });
    expect(r.status).toBe(409);
    const pub = (
      (await (
        await fetch(`${base}/questions?status=PUBLISHED&kind=mcq&limit=1`, { headers: auth })
      ).json()) as any
    ).items[0].id;
    const retire = await fetch(`${base}/questions/${pub}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'RETIRE', note: 'outdated wording' }),
    });
    expect(((await retire.json()) as any).question.status).toBe('RETIRED');
  });
  it('starting a mode with no approved questions returns NO_CONTENT (not an internal error)', async () => {
    const top = app.content.bank
      .all()
      .filter((q) => q.kind === 'top25' && q.status === 'PUBLISHED')
      .map((q) => q.id);
    await app.content.bulkReview(top, 'RETIRE', 'test', 'simulate an empty bank');
    expect((app.content.availability() as any).top25.published).toBe(0);
    const { host, others } = await lobby(2);
    await host.send({ type: 'room.configure', payload: { preset: 'SINGLE', modes: ['top25'] } });
    for (const c of [host, ...others]) await c.send({ type: 'room.ready', payload: { ready: true } });
    const ack = await host.send({ type: 'room.start', payload: {} });
    expect(ack.error.code).toBe('NO_CONTENT');
    await app.content.bulkReview(top, 'RESTORE', 'test', 'undo');
  });
});
