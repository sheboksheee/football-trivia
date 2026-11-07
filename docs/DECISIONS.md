# Decision log

Legend: **APPROVED** = user-confirmed (authoritative). **PROPOSED** = chosen by the build to make the game runnable; clearly labelled in code (`MODES[*].proposed`, comments marked `PROPOSED`) and in the UI ("Provisional rules"). Every PROPOSED item needs product approval or change before production. **BLOCKED** = not implemented because it would require inventing gameplay policy.

## Approved (unchanged from the kit)
- Web-first mobile-ready, React + TypeScript, future Capacitor.
- Room System V1.0: spectators without a fixed product cap; pause between questions and logged emergency pause; 30s reconnection.
- Hybrid Referee with impartial review.
- Match Night 5/3/1/0 with shared-place average; championship ladder and max five simultaneous MCQ tiebreaks, then shared champions.
- 12 game modes as described in canonical GDD/Blueprint.

## BLOCKED — needs a product decision before code
| Item | Why | Effect today |
|---|---|---|
| **Who Am I?** rules | Clue timing, input type, wrong-answer handling and ties are unspecified; GDD §4 says not to infer them. | Shown as "Awaiting rules", cannot be added to a playlist. Full Marathon (12) is therefore unavailable. |
| TOP 25 tie rule (Sudden Draft vs Final Equalizer) | Conflicting rules in GDD §4 / Blueprint K. | No mode tie-break; equal totals share the place (see P-T2). |
| Pass & Play support matrix | Blueprint K. | Not implemented. Private Online rooms only (local multi-device works through the same online room). |
| In-game kick voting policy | "eligible-majority approval" undefined. | Host can remove spectators in-game and anyone in the lobby; in-game participant kicks are refused with an explanation. |
| Emergency-pause limits/abuse policy | GDD §16. | Unlimited, host-only, reason required, fully audited. |
| Neutral-judge policy for 2-player rooms | GDD §16. | Judge must join as a separate non-playing member. |
| Licensed data provider | Commercial rights unverified. | Only a fictional fixture is integrated (see Content). |

## PROPOSED — gameplay parameters awaiting approval

### Mode parameters
| ID | Mode | Proposal |
|---|---|---|
| P-A1 | Auction | One auction per player; the opener rotates by seat. |
| P-A2 | Auction | Opening bid ≥ 1, each raise must exceed the current bid, max bid = size of the verified answer universe. A max bid ends bidding (remaining players drop in seat order; last one is challenger). |
| P-A3 | Auction | 15s per bidding decision; timeout = drop (opener timeout = opening bid of 1). |
| P-A4 | Auction | If the judge has not tapped within 15s of the challenge being set, the 30s starts automatically. Success is immediate when the count reaches the bid. |
| P-B1 | Buzzer | Buzzer open 10s per question (and after each reopen); nobody buzzes → reveal, no points. |
| P-B2 | Buzzer | Judge may rule until 8s + 5s grace; no verdict → that buzz is void (0) and the question ends. "Timeout" verdict only allowed after 8s. |
| P-C1 | Connections | One typed submission per player per puzzle. |
| P-C2 | Connections | Non-matching answers go to judge review (if a judge is present) as alternative links; without a judge they are wrong (appealable). |
| P-T1 | Timeline | Server-assigned balanced pairings: round r, seat i challenges seat i+1+r (skip self). N=2 → 4 duels between the pair. 3s duel intro. |
| P-I1 | Impostor | Rounds = players; each player is impostor once in seeded random order. |
| P-I2 | Impostor | Caught only with strictly the most votes (top tie → escape). No self-votes; no vote = abstain. The impostor's vote does not score. |
| P-I3 | Impostor | The current clue-giver may end their 10s turn early ("Done"). |
| P-L1 | Last Man Standing | Ends at ≤1 alive or after 15 questions. |
| P-L2 | Last Man Standing | Order: alive > more hearts > later elimination. Equal keys (incl. simultaneous elimination) share the place; native score = exact average of 5/3/1/0 for the shared places, + 1 perfect survival (alive with 3 hearts) added after placement. |
| P-R1 | Risk It | Turns are sequential in seat order (6 rounds × N players). |
| P-R2 | Risk It | No risk chosen in 10s → SAFE; no answer in 15s → wrong (penalty applies). |
| P-R3 | Risk It | Question is the same whatever risk is chosen (no per-tier pools yet; Blueprint C3 calibration pending). |
| P-T2 | TOP 25 | Game also ends when all 25 are found or after 25 snake rounds (safety cap). No Sudden Draft. |

### Cross-mode rules
| ID | Proposal |
|---|---|
| P-X1 | Simultaneous-question modes close a question early once every eligible player has answered (no effect on scores; Missing XI/Guess the Match tiers are fixed at submission time). |
| P-X2 | Appeals: decision ACCEPT = claimant's answer regraded correct (Auction: outcome flips in claimant's favour; TOP 25: judge must name the rank and it must be unclaimed earlier); VOID = item voided for everyone; REJECT = no change. Scores are recomputed from the event log; nothing is edited by hand. |
| P-X3 | Any pending appeal freezes the mode clock until resolved (Blueprint F: "question cannot be committed while appeal is unresolved"). |
| P-X4 | No eligible neutral reviewer (no connected judge, or the only judge graded the item) → the appeal immediately voids the item for everyone (GDD §7). **Risk:** in judge-less rooms a losing player can void any question; approve, or require a judge for appeals. |
| P-X5 | Who may appeal: the players who answered that item (Risk It/TOP 25: the turn player; Timeline: both duelists; Buzzer: players graded wrong/timeout; Auction: bidder and challenger; Impostor: any player). TOP 25 appeal windows run alongside play (15s after each wrong guess) so turns keep flowing. |
| P-X6 | A mode without its own tie-break ranks equal native scores as a shared place (Match Night averaging then applies). |
| P-X7 | Sole-finish counting for the ladder ignores tied places (Blueprint G "RECOMMENDED"). |
| P-X8 | Championship tie-break: only the group tied for 1st plays; per question correct beats wrong; all-correct/all-wrong rounds separate nobody; players eliminated later rank above those eliminated earlier; other ties remain shared ranks. Tie-break questions are appealable like any other. |
| P-X9 | Forfeit: a player absent beyond the 30s grace when a new mode starts (or who leaves during play) forfeits all future modes, keeps completed-mode points; a mode whose minimum is no longer met is skipped; < 2 active players ends the night. |
| P-X10 | Lobby: a member disconnected > 30s is removed (host included). Host leaving explicitly transfers host immediately. |
| P-X11 | No successor available → room SUSPENDED (clock frozen); the first returning player becomes host and play resumes. |
| P-X12 | "Between questions" (host pause) = reveal/result phases, mode intro and mode results. A pause requested mid-question is queued and applied at the next boundary. |
| P-X13 | Extra preset **Single mode** (one mode, results still converted to placement) for practice/testing. Presets otherwise as GDD: Quick 3, Classic 5, Marathon 12, Custom 2–12 (unique modes). |
| P-X14 | UX timings: mode intro 10s, mode results 15s (host can skip both). |
| P-X15 | Judges and spectators must join before kick-off (spectators any time). Judges never count as players. |

## PROPOSED — technical implementation (not gameplay)
- Vite + React SPA/PWA (not Next.js), Node `ws` gateway, PostgreSQL with plain SQL migrations (no ORM), pnpm workspaces. Redis is **not** used yet: one process owns all rooms; horizontal scaling will need room-affinity routing + Redis pub/sub (Phase 6 backlog).
- State is applied in memory first, then appended to Postgres in order (per-room queue). A crash can lose the last few un-flushed events; acceptable for V1, revisit with synchronous append if needed.
- Resume tokens are HMAC-hashed at rest and **rotated on every resume**; a used token is rejected.
- Infrastructure safeguards (not product rules): spectator soft cap per room (`SPECTATOR_SOFT_CAP`, default 500), 10 join/resume attempts per minute per IP, 40-message burst / 20 msg/s per socket, 8 KB WebSocket frames.
- Admin access is a single bearer token (`ADMIN_TOKEN`). Real staff auth (SSO/roles) is a launch blocker.
- Fonts load from Google Fonts (OFL fonts, no files shipped). Privacy review may require self-hosting.
- Content: fictional fixture with deterministic generator; DEV policy auto-publishes fixture content; production defaults to STRICT (human review for everything). TOP 25 lists use a documented tie-break ("fewer league starts ranks higher"); lists still tied after it are rejected.
- Difficulty weights (Blueprint C1) and pilot calibration threshold (50 responses) used as starting hypotheses only.
- **Language:** Egyptian colloquial Arabic ("rosh" tone) is the default UI language, with English one tap away. Every screen, mode name, rule text, error and lobby message is localised (`apps/web/src/i18n.ts`, `apps/web/src/modeText.ts`); server start-issues carry stable codes so the client can translate them. Arabic font: Cairo (Google Fonts, OFL). The copy needs a native review before launch. **Question content (prompts, players, clubs) is still English**: it comes from the fictional English-language dataset — Arabic question templates are a follow-up task.

Keep this log updated when the user approves or changes any item. Approving a PROPOSED item = move it to "Approved" and set the mode's `rulesStatus` to `APPROVED` once all its items are approved.
