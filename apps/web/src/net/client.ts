import type { AckMessage, ClientCommand, ServerMessage } from '@ft/shared';
import type { RoomView } from '@ft/game-rules';

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface Snapshot {
  status: ConnStatus;
  view: RoomView | null;
  /** performance.now() when the view arrived — used to tick timers locally */
  receivedAt: number;
  memberId: string | null;
  roomCode: string | null;
  kicked: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
}

interface Session {
  code: string;
  memberId: string;
  token: string;
}

const SESSION_KEY = 'ft.session';

function loadSession(): Session | null {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    return s ? (JSON.parse(s) as Session) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: session lasts for this tab only */
  }
}

/**
 * Thin client: sends validated commands, renders whatever the server projects. It never computes
 * scores, timers or results itself — the server is authoritative.
 */
export class GameClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { ok: (a: AckMessage) => void; timer: ReturnType<typeof setTimeout> }>();
  private retry = 0;
  private wantOpen = false;
  private session: Session | null = loadSession();
  snap: Snapshot = {
    status: 'idle',
    view: null,
    receivedAt: 0,
    memberId: null,
    roomCode: null,
    kicked: null,
    lastError: null,
    lastErrorCode: null,
  };

  constructor(private readonly url = defaultUrl()) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  get savedSession() {
    return this.session;
  }

  connect(): Promise<void> {
    this.wantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
      return this.ready();
    this.set({ status: this.retry > 0 ? 'reconnecting' : 'connecting' });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ status: 'online', lastError: null, lastErrorCode: null });
      if (this.session && this.snap.roomCode) void this.resume();
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    ws.onclose = () => {
      this.ws = null;
      for (const [, p] of this.pending) clearTimeout(p.timer);
      for (const [id, p] of this.pending)
        p.ok({ t: 'ack', id, ok: false, error: { code: 'INTERNAL', message: 'Connection lost' } });
      this.pending.clear();
      if (!this.wantOpen) return this.set({ status: 'idle' });
      this.set({ status: 'reconnecting' });
      const delay = Math.min(8000, 400 * 2 ** this.retry++) + Math.random() * 300;
      setTimeout(() => this.wantOpen && void this.connect(), delay);
    };
    return this.ready();
  }

  private ready(): Promise<void> {
    return new Promise((ok, fail) => {
      const check = () => {
        if (this.ws?.readyState === WebSocket.OPEN) return ok();
        if (!this.wantOpen) return fail(new Error('closed'));
        setTimeout(check, 50);
      };
      check();
    });
  }

  private onMessage(m: ServerMessage) {
    if (m.t === 'ack') {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        p.ok(m);
      }
      if (!m.ok && m.error) this.set({ lastError: m.error.message, lastErrorCode: m.error.code });
    } else if (m.t === 'welcome') {
      this.session = { code: m.roomCode, memberId: m.memberId, token: m.resumeToken };
      saveSession(this.session);
      this.set({ memberId: m.memberId, roomCode: m.roomCode, kicked: null });
    } else if (m.t === 'state') {
      this.set({ view: m.view as RoomView, receivedAt: performance.now() });
    } else if (m.t === 'kicked') {
      if (m.reason.includes('another connection')) {
        this.wantOpen = false;
      } else {
        this.session = null;
        saveSession(null);
      }
      this.set({ kicked: m.reason, view: null, roomCode: null });
    }
  }

  async send(command: ClientCommand, opts: { expectedVersion?: number } = {}): Promise<AckMessage> {
    await this.connect();
    const id = crypto.randomUUID();
    return new Promise((ok) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        ok({ t: 'ack', id, ok: false, error: { code: 'INTERNAL', message: 'Server did not respond' } });
      }, 10_000);
      this.pending.set(id, { ok, timer });
      this.ws!.send(
        JSON.stringify({
          id,
          command,
          ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        }),
      );
    });
  }

  act(action: Record<string, unknown>) {
    return this.send({ type: 'game.action', payload: { action } });
  }

  /** Rejoin with the stored rotating token (after refresh or network loss). */
  async resume(code?: string): Promise<AckMessage | null> {
    const s = this.session;
    if (!s || (code && s.code !== code)) return null;
    this.set({ roomCode: s.code });
    const ack = await this.send({ type: 'session.resume', payload: { code: s.code, resumeToken: s.token } });
    if (
      !ack.ok &&
      (ack.error?.code === 'UNAUTHORIZED' ||
        ack.error?.code === 'FORBIDDEN' ||
        ack.error?.code === 'NOT_FOUND')
    ) {
      this.session = null;
      saveSession(null);
      this.set({ roomCode: null, view: null });
    }
    return ack;
  }

  async leave() {
    if (this.snap.roomCode) await this.send({ type: 'room.leave', payload: {} });
    this.session = null;
    saveSession(null);
    this.set({ view: null, roomCode: null, memberId: null });
  }

  clearKick() {
    this.set({ kicked: null });
  }
  clearError() {
    this.set({ lastError: null, lastErrorCode: null });
  }
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export const client = new GameClient();
