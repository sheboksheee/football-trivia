# Football Intelligence Engine — Build Contract

## Pipeline
Licensed source adapter -> raw snapshot (immutable provenance) -> normalized entity/fact -> independent verification -> question candidate -> distractor/hint validator -> difficulty estimate -> admin review / safe automatic approval rules -> published version -> exposure tracking -> calibration.

Never let an LLM hallucination become a source of truth. LLM may propose wording, hints and distractors; validate every answer and distractor against canonical fact scope and source evidence.

## Publication gates
- `license_status=APPROVED` for intended use; source attribution recorded.
- Exact competition, season, match date, statistic definition, inclusion/exclusion and cutoff specified.
- Verified factual key, valid aliases, unambiguous single correct answer when mode requires it.
- Distractors are real entities and cannot also satisfy the stem.
- Dedupe by canonical fact and semantic question fingerprint.
- If conflicting source facts, status `QUARANTINED` until reviewed.
- No question leaks its correct answer through hints or UI payload before reveal.
- Each question has source, evidence URL/record ID, verification status, revision and audit trail.

## Difficulty
Estimate initially using era, popularity, rarity, reasoning steps, distractor similarity, mode-specific complexity. Calibrate after sufficient attempts with Bayesian-smoothed accuracy and player-skill normalization; avoid judging difficulty on tiny samples. Keep easy/medium/hard distributions balanced per playlist and prevent repeats within the same room/session.

## Vendor strategy
Implement provider interfaces first and a legally permitted local fixture for development. Integrate one authorized API at a time. Do not claim that public websites grant scraping or commercial redistribution rights. Rate-limit, cache, backoff, handle outages, and track per-provider costs.
