# Claude Code implementation roadmap

## Phase 0 — workspace bootstrap
Create pnpm monorepo, React + Vite web app, Node TypeScript API, shared packages, lint, formatting, tests, CI. Add health check, simple landing screen, environment example. Do not implement real game yet.
**Done when:** install, typecheck, lint and tests pass.

## Phase 1 — identities and room skeleton
Anonymous display-name session, 6-character invite codes, 2–6 player cap, spectators, ready check, host migration, reconnect token, audit trail, permissions. Use server-owned state.
**Done when:** two browser sessions can join one room; reconnect and host migration tests pass.

## Phase 2 — content pipeline minimum
Start with one legally usable structured football data source and a small curated fixture. Implement source registry, provenance, normalized entities, evidence, conflicts, question candidate/verification/publishing states. Admin review page. No LLM publishing.
**Done when:** unverified candidate cannot enter active game.

## Phase 3 — first playable vertical slice
Implement Higher or Lower with verified stat comparisons, 10-second server timers, five questions, +2 correct, +1 nonoverlapping pairs (1,2)/(3,4), +3 perfect, maximum 15. Multiplayer scoreboard and provisional result/appeal.
**Done when:** 2–6 players complete game, disconnect tests pass, deterministic replay passes.

## Phase 4 — Match Night
Mode playlist validation, exact rational placement points, championship ladder and five-question tie-break, persistence and result history.

## Phase 5 — expand modes
Implement modes individually with deterministic rules and property-based tests. Resolve remaining product ambiguities before coding affected modes.

## Phase 6 — intelligence and scaling
Add multiple licensed adapters, cross-source checks, question templating, human review, difficulty calibration, deduplication, exposure balancing, observability and load tests.

## Phase 7 — launch
Accessibility, anti-cheat, localization, privacy, moderation, production hosting, backup/restore, security review, PWA. Later Capacitor mobile packaging.

## First Claude prompt
Read CLAUDE.md and docs/IMPLEMENTATION_PLAN.md. Implement Phase 0 only, using a pnpm monorepo, Vite React TypeScript frontend, Node TypeScript backend, and Vitest. Provide working commands, tests and a clear README. Do not implement speculative gameplay rules. Stop after Phase 0 and summarize changed files.
