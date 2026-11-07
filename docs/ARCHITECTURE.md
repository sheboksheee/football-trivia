# Architecture and safety

- Monorepo: `apps/web` (React, Vite, TypeScript, PWA), `apps/server` (Node.js, TypeScript, WebSockets), `packages/shared`, `packages/game-rules`, `services/content`.
- PostgreSQL for durable events, room state, published questions, source evidence, reviews, scores; Redis for ephemeral presence and pub/sub if scaling demands.
- Server-owned room state machine; all commands validated with identity, role, room membership, expected version and idempotency key.
- Event log replay to reconstruct standings; transactions prevent double score awards; exact fractions for Match Night shared placement.
- Reconnect 30s, no timer reset; host migration atomic; spectator traffic never receives hidden role or answer payloads.
- Operational spectator capacity may be rate-limited without imposing a fixed product-rule maximum.
- Pause between questions, emergency pause with reason and auditable server time; never reveal answers while paused.
- No production deployment without load, abuse, security, privacy and license checks.
