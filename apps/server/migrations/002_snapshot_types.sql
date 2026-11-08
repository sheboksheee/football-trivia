-- Provider snapshots need their record type and external id to be re-normalised after a restart.
ALTER TABLE raw_snapshots ADD COLUMN IF NOT EXISTS record_type TEXT;
ALTER TABLE raw_snapshots ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE INDEX IF NOT EXISTS raw_snapshots_source ON raw_snapshots (source_id);
