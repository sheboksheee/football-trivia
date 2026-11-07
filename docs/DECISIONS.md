# Decision log

## Approved
- Web-first mobile-ready, React + TypeScript, future Capacitor.
- Room System V1.0: spectators without a fixed product cap; pause between questions and logged emergency pause; 30s reconnection.
- Hybrid Referee with impartial review.
- Match Night 5/3/1/0 with shared-place average; championship ladder and max five simultaneous MCQ tiebreaks, then shared champions.
- 12 game modes as described in canonical GDD/Blueprint.

## Proposed technical implementation, NOT approved gameplay rules
- Vite + React, Node.js WebSocket service, PostgreSQL, Redis, pnpm.
- Specific cloud provider, authentication vendor, API vendor, admin workflow.
- Server safety caps for spectator traffic.
- Exact rules for Who Am I?, TOP 25 edge cases, Pass & Play mode support.

Keep this log updated when the user approves a change.
