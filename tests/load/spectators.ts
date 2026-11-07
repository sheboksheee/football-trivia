/**
 * Spectator fan-out load test. Starts nothing itself: point it at a running server.
 *   FT_URL=ws://localhost:8787/ws SPECTATORS=300 pnpm --filter @ft/load test
 * Measures, per state broadcast, the delay between the first and each spectator receiving it.
 * Results establish an infrastructure capacity figure; they are NOT a product-rule cap.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const URL = process.env.FT_URL ?? 'ws://localhost:8787/ws';
const N = Number(process.env.SPECTATORS ?? 150);

function open(): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => ok(ws));
    ws.once('error', fail);
  });
}
function send(ws: WebSocket, command: unknown) {
  const id = randomUUID();
  ws.send(JSON.stringify({ id, command }));
  return new Promise<any>((ok) => {
    const on = (d: WebSocket.RawData) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'ack' && m.id === id) {
        ws.off('message', on);
        ok(m);
      }
    };
    ws.on('message', on);
  });
}

const host = await open();
let code = '';
host.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'welcome') code = m.roomCode;
});
await send(host, { type: 'room.create', payload: { displayName: 'Host', locale: 'en' } });
const p2 = await open();
await send(p2, { type: 'room.join', payload: { code, displayName: 'P2', role: 'PLAYER' } });

const arrivals = new Map<number, number[]>(); // version -> receive times
const specs: WebSocket[] = [];
let joinFailures = 0;
for (let i = 0; i < N; i++) {
  const s = await open();
  s.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t !== 'state') return;
    const v = m.view.room.version;
    const list = arrivals.get(v) ?? [];
    list.push(performance.now());
    arrivals.set(v, list);
  });
  const ack = await send(s, {
    type: 'room.join',
    payload: { code, displayName: `S${i}`, role: 'SPECTATOR' },
  });
  if (!ack.ok) joinFailures++;
  specs.push(s);
}
arrivals.clear();
const t0 = performance.now();
for (let k = 0; k < 20; k++) {
  await send(host, { type: 'room.ready', payload: { ready: k % 2 === 0 } });
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 1500));
const spreads: number[] = [];
let delivered = 0;
for (const times of arrivals.values()) {
  delivered += times.length;
  const first = Math.min(...times);
  for (const t of times) spreads.push(t - first);
}
spreads.sort((a, b) => a - b);
const pct = (p: number) =>
  spreads[Math.min(spreads.length - 1, Math.floor((p / 100) * spreads.length))]?.toFixed(1);
const expected = 20 * N;
console.warn(
  JSON.stringify(
    {
      spectators: N,
      joinFailures,
      broadcasts: arrivals.size,
      delivered,
      expected,
      fanoutSpreadMs: { p50: pct(50), p95: pct(95), max: pct(100) },
      wallMs: Math.round(performance.now() - t0),
    },
    null,
    1,
  ),
);
for (const s of [...specs, host, p2]) s.close();
process.exit(delivered >= expected * 0.99 && joinFailures === 0 ? 0 : 1);
