# FOOTBALL TRIVIA — AUTONOMOUS BUILD KIT

**Your one instruction to Claude Code:** `Read START_HERE.md and CLAUDE.md. Build Football Trivia autonomously, phase by phase, with tests. Start now.`

This kit is a *specification and build orchestration package*, not a functioning application yet.

## Claude's mission
Build a polished, production-minded, mobile-first multiplayer football trivia product, not a static mockup. Own implementation, UI/UX, testing, migrations, accessibility, documentation, and local developer setup. Maintain clear progress records and run the app after each milestone.

## Operating loop
1. Read `CLAUDE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md`, `docs/DATA_SOURCES.md`, and all three DOCX files in `docs/reference` (extract DOCX text programmatically if needed).
2. Produce `docs/BUILD_STATUS.md` and a task backlog; don't overwrite approved rules.
3. Implement one vertical slice; run lint/typecheck/tests/build; fix errors; record evidence and next tasks.
4. Continue through the phases without asking the user to approve routine engineering choices. Never bypass missing data rights, payment, external account creation, privacy decisions, or unresolved game rules. Log blockers clearly.
5. For UI, build reusable design tokens, real interactive screens, loading/empty/error states and responsive layouts. No placeholder buttons or fake functionality presented as finished.
6. On each checkpoint, tell the user how to run and test what exists. Continue if tools/time permit; don't claim to work after the session ends.

## Definition of finished
All 12 approved modes playable with tested server-authoritative scoring, room lifecycle, spectator privacy, Match Night ladder, licensed question pipeline, admin review, observability, accessibility, responsive PWA, documentation and deployment instructions. Mobile app wrapping is a later verified release task.
