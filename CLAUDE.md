# CLAUDE.md — Football Trivia project contract

You are implementing Football Trivia, a football multiplayer trivia game.

## Non-negotiable
- Never silently modify approved game rules.
- Do not invent football facts, source permissions, API endpoints, API keys, or licenses.
- All clocks, answer submissions, points, ranking, voting and host transfer are server authoritative.
- Ensure deterministic, replayable scoring; use append-only events and idempotency keys.
- Keep secrets server-side; do not send correct answers or hidden impostor roles to unauthorized clients.
- Add tests for every game rule and edge case before moving to the next mode.
- Mobile-first responsive UI; web-first with future Capacitor compatibility.
- Use TypeScript strict mode, runtime schema validation, structured logs and migrations.
- Never scrape or redistribute a source without verifying terms, licensing and robots/access requirements.
- AI generates wording and candidate questions; verified structured facts determine correctness.
- Disputed or conflicting data => quarantine; no automatic publishing.

## Approved game product
- 12 modes: Who Am I?, Football Auction + 30 Seconds, Buzzer Battle, Connections, Higher or Lower, Timeline, The Impostor, Last Man Standing, Risk It, Missing XI, Guess the Match, TOP 25.
- Match Night placement: 1st 5, 2nd 3, 3rd 1, 4th+ 0. Shared places split arithmetic average of occupied placement values; use exact fractions.
- Final tie ladder: total placement points, unique 1st places, unique 2nd places, unique 3rd places, then up to five simultaneous 15-second MCQs (no speed bonus); persistent ties are shared champions.
- 2–6 players; individual modes may require 3+.
- Unlimited spectators as a product rule, but infrastructure may impose capacity safeguards.
- Hybrid referee; impartial conflict handling and audit log.
- Appeal window 15 seconds; server preserves original answer and timestamp.
- Reconnect grace 30 seconds; no extra answer time.
- Host pause between questions; emergency pause requires a logged reason.
- Room roles Host, Judge, Player; host transfer after grace.
- Web-first React + TypeScript; future Capacitor iOS/Android.

## Implementation workflow
1. Read docs/IMPLEMENTATION_PLAN.md and the canonical DOCX files.
2. Identify ambiguities. Never silently decide gameplay policy.
3. Implement one small vertical slice at a time.
4. Run unit/integration tests and report failures.
5. Keep docs/DECISIONS.md updated with proposed vs approved decisions.

## Security
- Validate all client events server-side.
- Prevent replay, duplicate submission, unauthorized role changes, hidden answer leaks.
- Enforce rate limits, scoped room access, session rejoin tokens, audit logs.
- Protect spectators from secret information and answer leakage.

## Not yet final
- Who Am I? detailed rules, Pass & Play support matrix, TOP 25 equalizer/sudden draft edge cases.
- API vendor selection and commercial licenses.
- Production infrastructure scaling and billing.

## Autonomous build instructions
Read START_HERE.md first. Execute successive phases autonomously when tests pass. Treat `docs/DESIGN_SYSTEM.md`, `docs/CONTENT_ENGINE.md`, `docs/ARCHITECTURE.md` and `docs/ACCEPTANCE_TESTS.md` as implementation contracts. Stop for missing commercial licenses, account credentials, payments or unresolved game rules; do not invent them. Keep `docs/BUILD_STATUS.md` current.
