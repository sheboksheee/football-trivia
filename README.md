# Football Trivia — Claude Code Starter

This is a **planning and implementation starter**, not a finished or running game.

## Quick start
1. Install Node.js LTS, Git, and Claude Code.
2. Extract this folder and open it in VS Code.
3. Open a terminal in this folder and run `claude`.
4. Ask Claude: `Read CLAUDE.md and docs/IMPLEMENTATION_PLAN.md. Implement Phase 0 only. Show me all commands before running destructive actions.`
5. Review the generated code and tests before proceeding.

## Intended architecture
- `apps/web`: React + TypeScript + Vite + PWA, mobile-first; future Capacitor wrapper.
- `apps/server`: Node.js + TypeScript + authoritative multiplayer engine and WebSocket transport.
- `packages/shared`: types, validators, scoring contracts.
- `packages/game-rules`: deterministic mode state machines.
- `services/content`: football data ingestion, fact checks, question generation, difficulty calibration.
- PostgreSQL + Redis (recommended; provision when implementing).

## Key rule
Do not fabricate verified football facts. No question can be published without evidence and permitted usage rights.

## Canonical source documents
Copy the three supplied GDD/Blueprint DOCX files into `docs/reference/` before asking Claude to implement mode rules. If any discrepancy appears, stop and ask for a decision.
