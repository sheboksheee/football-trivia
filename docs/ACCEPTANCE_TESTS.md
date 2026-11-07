# Mandatory acceptance tests

- 2–6 players join/leave; room invite collision resistance; reconnect token reuse rejected.
- Host disconnect triggers transfer; previous host returns without automatically regaining host.
- Spectators never see answers, impostor role, private votes, judge secrets.
- Timer is server authoritative; simultaneous submissions and buzzer races deterministic; duplicate command idempotent.
- Appeals do not let players edit original answer; conflicted judge cannot adjudicate own answer.
- Placement 5/3/1/0 with exact fractional shared-place averaging; tiebreak ladder five questions then shared champions.
- Data source conflict blocks publication; license pending blocks publication; wrong distractor that also answers question blocks publication.
- Difficulty metrics avoid reclassification on insufficient sample size.
- Every mode has scoring examples, timeout, tie, disconnect, and replay tests.
- PWA works at mobile widths and desktop; RTL keyboard and reduced motion tested.
