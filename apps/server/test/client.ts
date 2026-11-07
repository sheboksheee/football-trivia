import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export class TestClient {
  ws!: WebSocket;
  messages: any[] = [];
  states: any[] = [];
  memberId = '';
  token = '';
  code = '';
  private waiters: Array<{ pred: (m: any) => boolean; ok: (m: any) => void }> = [];
  static async connect(port: number) {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((ok, fail) => {
      c.ws.once('open', ok);
      c.ws.once('error', fail);
    });
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.messages.push(m);
      if (m.t === 'state') c.states.push(m.view);
      if (m.t === 'welcome') {
        c.memberId = m.memberId;
        c.token = m.resumeToken;
        c.code = m.roomCode;
      }
      for (const w of [...c.waiters])
        if (w.pred(m)) {
          c.waiters.splice(c.waiters.indexOf(w), 1);
          w.ok(m);
        }
    });
    return c;
  }
  get view() {
    return this.states[this.states.length - 1];
  }
  wait(pred: (m: any) => boolean, timeout = 8000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('timeout waiting for message')), timeout);
      this.waiters.push({ pred, ok: (m) => (clearTimeout(t), ok(m)) });
    });
  }
  waitView(pred: (v: any) => boolean, timeout = 8000) {
    if (this.view && pred(this.view)) return Promise.resolve(this.view);
    return this.wait((m) => m.t === 'state' && pred(m.view), timeout).then((m) => m.view);
  }
  async send(command: unknown, id: string = randomUUID(), extra: Record<string, unknown> = {}) {
    this.ws.send(JSON.stringify({ id, command, ...extra }));
    return this.wait((m) => m.t === 'ack' && m.id === id);
  }
  raw(s: string) {
    this.ws.send(s);
  }
  close() {
    this.ws.close();
    return new Promise((ok) => this.ws.once('close', ok));
  }
}
