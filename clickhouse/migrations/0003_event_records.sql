-- Expand the event log before deploying ingest contract 2. Existing ingest builds omit these
-- columns and keep writing ordinary events. Profile/group mutations use the same dedup boundary.
ALTER TABLE highkey.events
    ADD COLUMN IF NOT EXISTS record_type LowCardinality(String) DEFAULT 'event',
    ADD COLUMN IF NOT EXISTS backfill Bool DEFAULT false,
    ADD COLUMN IF NOT EXISTS profile_id Nullable(String) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS group_type String DEFAULT '',
    ADD COLUMN IF NOT EXISTS group_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS group_name String DEFAULT '',
    ADD COLUMN IF NOT EXISTS traits JSON,
    ADD COLUMN IF NOT EXISTS increments JSON,
    ADD COLUMN IF NOT EXISTS groups Map(String, String) DEFAULT map(),
    ADD COLUMN IF NOT EXISTS ai_prompt String DEFAULT '' TTL toDateTime(event_time) + INTERVAL 30 DAY;

INSERT INTO highkey.ingest_contract
SELECT 2 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version = 2) = 0;
