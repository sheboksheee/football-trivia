-- Football Trivia initial schema. Append-only tables are never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only room event log; replaying it reconstructs room state deterministically.
CREATE TABLE IF NOT EXISTS room_events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  at BIGINT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  command_id TEXT,
  payload JSONB NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS room_events_idem ON room_events (room_id, actor, command_id) WHERE command_id IS NOT NULL;

-- Resume tokens are stored hashed only; rotated on every successful resume.
CREATE TABLE IF NOT EXISTS room_sessions (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  member_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, member_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE IF NOT EXISTS rejected_commands (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT,
  member_id TEXT,
  command_id TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Score ledger: one immutable row per placement share awarded (exact fraction as text).
CREATE TABLE IF NOT EXISTS score_events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  mode_index INTEGER NOT NULL,
  mode_key TEXT NOT NULL,
  member_id TEXT NOT NULL,
  native_score TEXT NOT NULL,
  placement_points TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, mode_index, member_id)
);

CREATE TABLE IF NOT EXISTS match_records (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  final JSONB NOT NULL,
  results JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Content
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  license_status TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  hash TEXT NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_kind_status ON questions (kind, status);

CREATE TABLE IF NOT EXISTS question_audit (
  id BIGSERIAL PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL
);
