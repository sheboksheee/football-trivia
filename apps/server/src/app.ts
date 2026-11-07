import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize as normPath, resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { MODES, PLAYABLE_MODE_KEYS, type ContentItem } from '@ft/shared';
import { DEFAULT_TIMING, scaleTiming } from '@ft/game-rules';
import { SOURCES, ReviewError } from '@ft/content';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics } from './metrics.js';
import { MemoryPersistence, PostgresPersistence, type Persistence } from './persistence.js';
import { ContentService } from './contentService.js';
import { RoomManager, type Conn } from './roomManager.js';
import { TokenBucket } from './rateLimit.js';

export interface App {
  server: ReturnType<typeof createServer>;
  manager: RoomManager;
  content: ContentService;
  db: Persistence;
  log: Logger;
  adminToken: string;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };

const ReviewBody = z.object({ action: z.enum(['APPROVE', 'REJECT', 'RETIRE', 'QUARANTINE', 'RESTORE']), note: z.string().trim().min(3).max(1000), reviewer: z.string().trim().min(1).max(64).default('admin') });

export async function createApp(config: Config, opts: { db?: Persistence; now?: () => number; log?: Logger } = {}): Promise<App> {
  const log = opts.log ?? createLogger(config.LOG_LEVEL);
  const metrics = new Metrics();
  const db = opts.db ?? (config.DATABASE_URL ? new PostgresPersistence(config.DATABASE_URL) : new MemoryPersistence());
  await db.init();
  if (db.kind === 'memory') log.warn('DATABASE_URL not set: using in-memory storage (development only, nothing persists)');
  const strict = config.CONTENT_POLICY ? config.CONTENT_POLICY === 'STRICT' : config.production;
  const content = new ContentService(db, log, strict);
  await content.init();
  const timing = config.FT_TIME_SCALE === 1 ? DEFAULT_TIMING : scaleTiming(DEFAULT_TIMING, config.FT_TIME_SCALE);
  if (config.FT_TIME_SCALE !== 1) log.warn({ scale: config.FT_TIME_SCALE }, 'TEST TIMING SCALE ACTIVE — not for real games');
  const manager = new RoomManager({ db, content, log, metrics, timing, secret: config.SESSION_SECRET, spectatorSoftCap: config.SPECTATOR_SOFT_CAP, joinRatePerMinute: config.JOIN_RATE_PER_MINUTE, ...(opts.now ? { now: opts.now } : {}) });
  await manager.recover();
  const adminToken = config.ADMIN_TOKEN ?? (config.production ? '' : `dev-${randomUUID()}`);
  if (!config.ADMIN_TOKEN && !config.production) log.warn({ adminToken }, 'ADMIN_TOKEN not set; generated a development admin token');
  const webDist = config.WEB_DIST ? resolve(config.WEB_DIST) : null;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const isAdmin = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!adminToken || t.length !== adminToken.length) return false;
    return timingSafeEqual(Buffer.from(t), Buffer.from(adminToken));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((ok, fail) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 16_384) req.destroy();
      });
      req.on('end', () => {
        try {
          ok(data ? JSON.parse(data) : {});
        } catch (e) {
          fail(e);
        }
      });
    });

  const securityHeaders = (res: ServerResponse) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'");
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    securityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    metrics.inc('ft_http_requests_total', { path: path.startsWith('/api/admin') ? '/api/admin' : path.startsWith('/api') ? path : 'static' });
    if (path === '/healthz') return json(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), storage: db.kind });
    if (path === '/readyz') return json(res, 200, { ok: true, rooms: manager.roomCount() });
    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(metrics.render());
    }
    if (path === '/api/modes') return json(res, 200, { modes: Object.values(MODES), playable: PLAYABLE_MODE_KEYS, availability: content.availability() });
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'Admin token required' });
      const bank = content.bank;
      if (path === '/api/admin/summary' && req.method === 'GET')
        return json(res, 200, { counts: bank.counts(), conflicts: content.result.conflicts.length, sources: SOURCES.length });
      if (path === '/api/admin/sources') return json(res, 200, { sources: SOURCES });
      if (path === '/api/admin/conflicts') return json(res, 200, { conflicts: content.result.conflicts });
      if (path === '/api/admin/questions' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        const kind = url.searchParams.get('kind');
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        let list = bank.all();
        if (status) list = list.filter((x) => x.status === status);
        if (kind) list = list.filter((x) => x.kind === kind);
        if (q) list = list.filter((x) => JSON.stringify(x.item).toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
        return json(res, 200, {
          total: list.length,
          items: list.slice(offset, offset + limit).map((x) => ({ id: x.id, kind: x.kind, status: x.status, template: x.template, difficulty: x.difficulty.tier, difficultyStatus: x.difficulty.status, failing: x.gates.filter((g) => !g.passed).map((g) => g.message), summary: summarize(x.item) })),
        });
      }
      const m = /^\/api\/admin\/questions\/([\w-]+)(\/review)?$/.exec(path);
      if (m) {
        const q = bank.get(m[1]!);
        if (!q) return json(res, 404, { error: 'Not found' });
        if (!m[2] && req.method === 'GET') {
          const facts = q.factIds.slice(0, 60).map((id) => {
            const f = content.result.kb.factIndex.get(id);
            const snap = f ? content.result.kb.snapshots.get(f.evidenceId) : undefined;
            return f ? { ...f, evidence: snap ? { id: snap.id, hash: snap.hash, retrievedAt: snap.retrievedAt, recordType: snap.recordType } : null } : { id, missing: true };
          });
          return json(res, 200, { question: q, facts, totalFacts: q.factIds.length });
        }
        if (m[2] && req.method === 'POST') {
          const body = ReviewBody.safeParse(await readBody(req).catch(() => null));
          if (!body.success) return json(res, 400, { error: body.error.issues[0]?.message ?? 'Invalid body' });
          try {
            const updated = await content.review(q.id, body.data.action, body.data.reviewer, body.data.note);
            return json(res, 200, { question: updated });
          } catch (e) {
            if (e instanceof ReviewError) return json(res, 409, { error: e.message });
            throw e;
          }
        }
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (webDist && existsSync(webDist)) return serveStatic(webDist, path, res);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Web app not built. Run `pnpm dev` (Vite on :5173) or `pnpm build` then set WEB_DIST.');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error({ err }, 'http error');
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://local').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket & { isAlive?: boolean }, req: IncomingMessage) => {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const conn: Conn = {
      id: randomUUID(),
      ip,
      roomId: null,
      memberId: null,
      bucket: new TokenBucket(40, 20),
      send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      sendRaw: (s) => ws.readyState === ws.OPEN && ws.send(s),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => manager.handleRaw(conn, data.toString()));
    ws.on('close', () => manager.onClose(conn));
    ws.on('error', () => ws.terminate());
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);
  heartbeat.unref();

  return {
    server,
    manager,
    content,
    db,
    log,
    adminToken,
    listen: (port = config.PORT, host = config.HOST) =>
      new Promise((ok) => server.listen(port, host, () => ok((server.address() as { port: number }).port))),
    async close() {
      clearInterval(heartbeat);
      manager.shutdown();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((ok) => server.close(() => ok()));
      await manager.flush();
      await db.close();
    },
  };
}

function summarize(item: ContentItem): string {
  const i = item as unknown as Record<string, unknown>;
  return String(i.prompt ?? i.statLabel ?? i.title ?? i.category ?? i.match ?? i.footballer ?? (Array.isArray(i.entities) ? (i.entities as string[]).join(' · ') : '') ?? item.kind).slice(0, 140);
}

function serveStatic(root: string, urlPath: string, res: ServerResponse) {
  const safe = normPath(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(readFileSync(file));
}
