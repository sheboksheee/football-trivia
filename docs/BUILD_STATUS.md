# Build Status

**Status: playable vertical product (11 of 12 modes) — NOT production-ready.** Last verified 2026-11-07.

## How to verify (all passing at last run)
```bash
pnpm install
pnpm typecheck          # strict TS, 0 errors
pnpm lint               # eslint, 0 problems
pnpm format:check       # prettier
TEST_DATABASE_URL=postgresql://ft:ft@localhost:5432/football_trivia_test pnpm test   # 117 tests, 11 files
pnpm build              # web PWA + bundled server
pnpm test:e2e           # Playwright, 6 browser tests (incl. a full Arabic game on phone + laptop) (starts its own server)
FT_URL=ws://localhost:8787/ws SPECTATORS=300 pnpm --filter @ft/load test   # against a running server
```
Without `TEST_DATABASE_URL` the 2 PostgreSQL tests are skipped (115 run).

## Phase checklist
| Phase | State | Evidence |
|---|---|---|
| 0 — scaffold & dev setup | ✅ | pnpm monorepo, strict TS, ESLint, Prettier, Vitest projects, GitHub Actions CI (`.github/workflows/ci.yml`), `.env.example`, `/healthz`, Dockerfile (image build not tested here: no Docker daemon in this environment). |
| 1 — identities & room engine | ✅ | `packages/game-rules/src/room.ts` (pure, replayable reducer); `apps/server` WebSocket gateway. Tests: 2–6 cap, spectators, ready check, host migration (co-host → longest-present), returning host does not regain host, 30s grace, suspension, rotating resume tokens (reuse rejected), idempotent command ids, stale-version rejection, rate limits, spoofing. |
| 2 — licensed content pipeline | ✅ (dev data only) | `services/content`: source registry with license status, provider adapter contract, immutable sha256 snapshots, canonical entities, scoped facts, cross-source conflict detection → QUARANTINED, pending rights → BLOCKED_RIGHTS, mode validators (distractors, alternate links, clue uniqueness, leak check), dedupe, difficulty estimate + beta-binomial calibration (no reclassification below 50 responses), review workflow + audit, admin Content Studio. Unverified/unpublished items can never be drawn into a game. |
| 3 — first playable slice (Higher or Lower) | ✅ | Server-timed 10s questions, scoring table tests (max 15), appeals with 15s window, disconnect without timer extension, deterministic replay test, 2-player browser E2E to champion screen. |
| 4 — Match Night | ✅ | Exact-fraction placement (5/3/1/0 averaging), ladder (points → sole 1st/2nd/3rd), up to five 15s tie-break questions, shared champions, mode skipping on forfeit, persisted `score_events` + `match_records`. Property tests on shares and tie-break partitioning. |
| 5 — remaining modes | ⚠️ 10 of 11 remaining | Implemented with rule tests (scoring, timeout, tie, secrecy, appeals): Auction + 30s, Buzzer Battle, Connections, Timeline, The Impostor, Last Man Standing, Risk It, Missing XI, Guess the Match, TOP 25. **Who Am I? is BLOCKED** (rules not approved). 8 modes run on PROPOSED parameters (docs/DECISIONS.md). |
| 6 — intelligence & scaling | ⚠️ partial | Done: Prometheus `/metrics`, structured pino logs with secret redaction, spectator fan-out load test (300 spectators/room on one process: 100% delivery, fan-out spread p50 1.7 ms, p95 4.2 ms, max 6.9 ms), shared spectator projection. Not done: real licensed adapters (blocked), multi-instance scaling (Redis/affinity), calibration jobs fed by gameplay telemetry, exposure analytics UI. |
| 7 — launch | ❌ | See launch blockers below. |

## Acceptance tests (docs/ACCEPTANCE_TESTS.md) → where they live
- Join/leave 2–6, invite collision resistance, reconnect token reuse rejected → `room.test.ts`, `shared.test.ts`, `server.test.ts`
- Host transfer; returning host does not regain host → `room.test.ts`, `server.test.ts`
- Spectators never see answers/roles/votes/judge keys → engine view tests in `simultaneous-modes.test.ts`, `turn-modes.test.ts`; projection tests in `room.test.ts`; WebSocket + browser checks in `server.test.ts`, `game.spec.ts`
- Server timers; buzzer races deterministic; duplicate commands idempotent → `turn-modes.test.ts`, `server.test.ts`, `room.test.ts` ("advance is idempotent")
- Appeals keep original answer; conflicted judge cannot adjudicate → `room.test.ts` (appeals)
- Placement fractions, tie-break, shared champions → `placement.test.ts`, `room.test.ts`
- Conflict / pending license / bad distractor block publication → `pipeline.test.ts`
- Difficulty not reclassified on small samples → `pipeline.test.ts`
- Every mode: scoring examples, timeout, tie, disconnect, replay → mode tests, room tests, and `apps/server/test/soak.test.ts` (an 11-mode Match Night with random bots, judge and appeals over 3 seeds: completes, no skipped modes, placement shares sum to exactly 9 per mode, spectator never sees the Impostor secret, and the event log replays to byte-identical state).
- Mobile widths/desktop, RTL, keyboard, reduced motion, 44px targets → `tests/e2e/game.spec.ts`

## Blockers (need you — not engineering choices)
1. **Who Am I? rules** (timing, input type, wrong answers, ties).
2. **Approve or change every PROPOSED item** in `docs/DECISIONS.md` (8 modes are "Provisional").
3. **TOP 25 tie rule** and **Pass & Play** scope.
4. **Licensed football data**: choose a provider and confirm commercial redistribution rights. Until then the game runs only on the fictional dev league; no real-world question exists.
5. Production decisions: hosting/provider, staff authentication for the Content Studio, privacy policy & data retention, font hosting, Arabic translation review.

## Known limitations / next engineering tasks
- Single server process owns rooms (no horizontal scaling yet); in-memory apply then async Postgres append.
- Content Studio has no editing of question wording (review actions only) and no exposure/calibration dashboards.
- UI is fully Egyptian-Arabic by default (English toggle); the questions themselves are still English (fictional dataset) — Arabic question templates are next.
- No in-game kick UI (lobby kick is a server command without UI), no chat/mute/report.
- Spectator feed delay (anti-coaching) not implemented.
- Capacitor packaging not started (later verified release task per START_HERE).

## Run it
See README.md → "Run locally". Two terminals: `pnpm dev:server` and `pnpm dev:web`, open http://localhost:5173 in two browser windows.
