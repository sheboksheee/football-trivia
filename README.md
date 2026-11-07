# Football Trivia

Mobile-first multiplayer football trivia: private rooms for 2–6 players, unlimited spectators, an optional neutral judge, 11 playable modes and a **Match Night** championship with exact-fraction placement points.

**Try it online in one click:** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sheboksheee/football-trivia) — free demo instance (in-memory: rooms reset when it restarts/sleeps). The admin token is in Render → your service → Environment → `ADMIN_TOKEN`.

> **Data notice.** No licensed football data provider is integrated yet. All questions come from a **deterministically generated fictional league** ("Synthetic Dev League") so the game is fully playable without inventing real-world facts. See `docs/DATA_SOURCES.md` and `docs/DECISIONS.md`.

Status, evidence and blockers: **`docs/BUILD_STATUS.md`**. Rule decisions (approved vs proposed): **`docs/DECISIONS.md`**.

## Repository layout
| Path | What |
|---|---|
| `packages/shared` | Wire protocol (zod), exact `Fraction`, seeded RNG, answer normalisation (Latin + Arabic), mode catalog, content item types |
| `packages/game-rules` | Pure deterministic engines for 11 modes + championship tie-break, Match Night ladder, and the room reducer (lifecycle, roles, host migration, grace, pause/hold clock, appeals). Replaying the event log reproduces state exactly. |
| `services/content` | Content pipeline: sources & rights, provider adapter contract, fictional fixture, snapshots, facts, conflict quarantine, generators, publication gates, difficulty, question bank |
| `apps/server` | Node HTTP + WebSocket server: sessions, rotating resume tokens, idempotency, rate limits, timers, per-viewer redacted projections, PostgreSQL persistence/migrations/recovery, admin API, metrics |
| `apps/web` | React + Vite PWA: lobby, all mode screens, judge console, appeals, standings, champion, Content Studio; English + Arabic (RTL) |
| `tests/e2e` | Playwright browser tests · `tests/load` spectator fan-out load test |

## Requirements
Node ≥ 22, pnpm 10 (`corepack enable`), optionally PostgreSQL 16.

## Run locally
```bash
pnpm install
cp .env.example .env            # optional; the server reads real env vars
pnpm dev:server                 # http://localhost:8787 (in-memory storage unless DATABASE_URL is set)
pnpm dev:web                    # http://localhost:5173 (proxies /api and /ws to :8787)
```
Open http://localhost:5173 in two browser windows (or a phone on your LAN at `http://<your-ip>:5173`): create a room in one, join with the code in the other, both press **I'm ready**, host presses **Kick off**.

- **Judge-required modes** (Buzzer Battle, Football Auction): open a third window and join as **Judge**.
- **The Impostor** needs 3+ players.
- **Content Studio**: `#/admin`. In development the server prints a generated admin token in its log (or set `ADMIN_TOKEN`).
- **Faster manual testing**: `FT_TIME_SCALE=0.3 pnpm dev:server` shortens every timer (test-only; refused in production).

### With PostgreSQL
```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/football_trivia
pnpm db:migrate
pnpm dev:server
```
Rooms survive a server restart: unfinished rooms are rebuilt from the append-only event log and players rejoin with their stored token.

## Test
```bash
pnpm verify                     # typecheck + lint + unit/integration tests + build
TEST_DATABASE_URL=postgresql://... pnpm test   # also runs the PostgreSQL tests
pnpm test:e2e                   # Playwright (needs Chromium: pnpm --filter @ft/e2e exec playwright install chromium)
```

## Production
```bash
pnpm build
NODE_ENV=production DATABASE_URL=... SESSION_SECRET=$(openssl rand -hex 32) ADMIN_TOKEN=... \
  WEB_DIST=apps/web/dist node apps/server/dist/main.js
```
Production refuses to start without `SESSION_SECRET` and `DATABASE_URL` (unless `DEMO_MODE=true`, used by the one-click Render demo: in-memory rooms + fictional question bank), and uses the **STRICT** content policy: nothing is auto-published, every question needs human approval in the Content Studio. A `Dockerfile` is provided. Put TLS (wss) in front via your load balancer. See `docs/BUILD_STATUS.md` for the launch blockers that remain.

## Key rules (approved)
Match Night placement 1st 5 · 2nd 3 · 3rd 1 · 4th+ 0, shared places split exactly (e.g. 4/3). Ladder: points → sole 1sts → sole 2nds → sole 3rds → up to five 15s tie-break questions → shared champions. 15s appeal window, 30s reconnect grace without extra answer time, host pause between questions, emergency pause with logged reason, everything server-authoritative.
