-- Empty means collected before SDK reporting. A raw HTTP event from the new ingest is "http".
ALTER TABLE highkey.events ADD COLUMN IF NOT EXISTS sdk LowCardinality(String) DEFAULT '';

INSERT INTO highkey.ingest_contract
SELECT 4 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version = 4) = 0;
