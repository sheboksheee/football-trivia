# Football Data Source Strategy

These are **candidates**, not confirmed licensed integrations. Verify coverage, terms, API limits, commercial redistribution rights and current availability before implementing.

## Structured/API candidates
- Sportmonks — https://www.sportmonks.com/
- API-Football — https://www.api-football.com/
- football-data.org — https://www.football-data.org/
- Sportradar — https://sportradar.com/
- Stats Perform / Opta — https://www.statsperform.com/
- StatsBomb Open Data — https://github.com/statsbomb/open-data (dataset-specific license)
- OpenFootball — https://github.com/openfootball/football.json (check dataset license)
- Wikidata — https://www.wikidata.org/ (identity and aliases; assess individual claims)

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
