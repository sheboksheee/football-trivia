# Football Data Source Strategy

## Integrated: football-data.org API v4 (2026-11-08)
Verified on the official site and docs (not assumed):
- Auth header `X-Auth-Token`; base `https://api.football-data.org/v4`; endpoints used: `/competitions/{code}/matches|standings|teams?season=YYYY`.
- Free plan: 12 competitions (PL, PD, SA, BL1, FL1, CL, DED, PPL, ELC, BSA, WC, EC), results, fixtures, league tables, **10 calls/minute**. Line-ups, goal scorers and squads require the paid "Free + Deep Data" plan (€29/month) or higher.
- Without a token the API returns 403 with `X-Authenticated-Client: anonymous` (treated as missing/invalid key).
- Attribution: "Football data provided by the Football-Data.org API" is shown with every question from it.
- **Commercial use: no published terms found online.** The source starts as `PENDING`; the owner records the decision in the Content Studio (Private testing / Commercial / Denied) with an evidence note. Production (non-demo) servers only draw from sources marked Commercial.
- **Live run (2026-11-08, free plan):** PL, PD, SA, BL1, FL1 × seasons 2023–2026 = 60 requests, 0 refused, 6.4 minutes; 129 clubs, 5,731 finished matches, 15 completed seasons → ~940 questions awaiting human review.
- Data findings handled in code: (1) matches with status `AWARDED` (decided off the pitch) — the season counts as complete when every match is FINISHED or AWARDED, awarded results are never used as played scores, and table questions involving those teams carry a review warning; (2) stadium names can be outdated (e.g. Napoli's ground listed under its pre-2020 name), so every venue question carries a "confirm the current name" review note.
- Implementation: `services/content/src/providers/footballData.ts` (client, rate limit, 429 back-off, immutable sha256 snapshots) and `footballDataContent.ts` (zod-validated payloads, completed seasons and FINISHED matches only, question templates). Real questions are never auto-published.

## Integrated: Wikidata (2026-11-09)
- **License verified:** structured data is CC0 1.0 (https://www.wikidata.org/wiki/Wikidata:Licensing) — commercial use allowed, no attribution required (we still credit it). Starts `PENDING` like every source; the owner records the decision.
- Access: SPARQL `https://query.wikidata.org/sparql` + search API `https://www.wikidata.org/w/api.php?action=wbsearchentities`, 1 request/second, User-Agent `FootballTrivia/0.1 (https://github.com/sheboksheee/football-trivia)` per the Wikimedia User-Agent policy (no personal e-mail). Whole-graph queries ("all famous footballers") time out with HTTP 504 and also return non-footballers (writers, physicists, politicians with an old football occupation), so we query **one club at a time**.
- Club resolution (no hand mapping): football-data.org club name → search → keep items that are `P31/P279*` association football club (Q476028), drop women's/youth/reserve/academy sides, pick the one with the most Wikipedia sitelinks (live test: "Chelsea FC" search ranks a 1-sitelink stub item above the real club; sitelinks fixes it). Two clubs resolving to the same item are both dropped.
- Players: `P54` membership statements of that club (start/end qualifiers), occupation association football player (Q937857), ≥30 sitelinks, English + Arabic labels, `P1532` country for sport.
- Questions (all need human review): The Impostor (≥60 sitelinks), Connections (4 players of one club; rejected if they share another fetched club or a national team), MCQ "which of these clubs did he play for?" (distractors have no membership statement — Wikidata can be incomplete, the reviewer confirms).
- Live check (4 clubs): 802 players, 931 membership facts, 179 Impostor / 12 Connections / 379 MCQ candidates, Arabic names present for famous players.
- Implementation: `services/content/src/providers/wikidata.ts`.

## Integrated: OpenFootball football.json (2026-11-09) — cross-check only
- **License verified:** CC0 1.0 / public domain (LICENSE.md in the repository).
- Files: `https://raw.githubusercontent.com/openfootball/football.json/master/<YYYY-YY>/<en.1|es.1|it.1|de.1|fr.1>.json`, available 2019-20 → 2026-27.
- Use: every league match is paired with football-data.org by (league, season, home club, away club); names are matched typo-tolerantly against the club aliases, an unresolved name is reported and skipped. Equal full-time score = corroboration; different = the football-data fact becomes `CONFLICTED` → all dependent questions are `QUARANTINED`. Nothing is overwritten. No questions are generated from it directly.
- Implementation: `services/content/src/providers/openFootball.ts`.

## Next free source (planned): StatsBomb Open Data
- Event data incl. line-ups for selected competitions (Missing XI). Its user agreement must be checked first; likely non-commercial → **private testing only**.

These are **candidates**, not confirmed licensed integrations. Verify coverage, terms, API limits, commercial redistribution rights and current availability before implementing.

## Structured/API candidates
- Sportmonks — https://www.sportmonks.com/
- API-Football — https://www.api-football.com/
- football-data.org — https://www.football-data.org/
- Sportradar — https://sportradar.com/
- Stats Perform / Opta — https://www.statsperform.com/
- StatsBomb Open Data — https://github.com/statsbomb/open-data (dataset-specific license)

## Official verification references
- FIFA — https://www.fifa.com/
- UEFA — https://www.uefa.com/
- Premier League — https://www.premierleague.com/
- LaLiga — https://www.laliga.com/
- Bundesliga — https://www.bundesliga.com/
- Serie A — https://www.legaseriea.it/
- CAF — https://www.cafonline.com/
- AFC — https://www.the-afc.com/

## Historical cross-check candidates (not automatic scraping permission)
- RSSSF — https://www.rsssf.org/
- Transfermarkt — https://www.transfermarkt.com/
- FBref — https://fbref.com/
- 11v11 — https://www.11v11.com/
- worldfootball.net — https://www.worldfootball.net/
- BDFutbol — https://www.bdfutbol.com/

## Source priority and conflicts
1. Official competition match sheet for kickoff XI, result, venue and competition.
2. Licensed event/statistics provider for explicitly defined statistics.
3. Independent historical reference for cross-check.
4. General knowledge/AI text is NEVER authoritative evidence.

Record `source_id`, URL or vendor record ID, retrieved_at, observed_at, license_status, fact_scope, stat_definition, season, competition, team/player IDs, and evidence hash. If material sources disagree, mark CONFLICTED and block publication.

## Difficulty
Initial difficulty uses objective features (recognition, era, rarity, reasoning steps, distractor similarity). Calibrate with actual answer rate and player ability after enough attempts; avoid exposing answer correctness until round reveal. Separate difficulty by mode and player cohort. Prevent repeated questions per player and across a Match Night.
