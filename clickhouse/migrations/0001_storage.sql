-- Highkey's ClickHouse storage: events, logs, the ingest key registry and the reader profile.
-- Every statement is safe to repeat. A statement ends at a line ending with ";".

-- The ingest app writes these columns by name; add columns only with defaults.
CREATE TABLE IF NOT EXISTS highkey.events
(
    product_id UUID,
    source_id UUID,
    event_id String,
    name LowCardinality(String),
    source LowCardinality(String),
    event_time DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    actor_id Nullable(String),
    identity_kind LowCardinality(Nullable(String)),
    session_id Nullable(String),
    properties JSON,
    expires_at DateTime('UTC'),
    -- ReplacingMergeTree keeps the highest version, so the earliest received copy wins.
    dedup_version UInt64 MATERIALIZED bitNot(toUInt64(toUnixTimestamp64Milli(received_at))),
    INDEX event_id_bloom event_id TYPE bloom_filter GRANULARITY 1,
    INDEX received_at_minmax received_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(dedup_version)
PARTITION BY toYYYYMM(event_time)
ORDER BY (product_id, toDate(event_time), name, event_id)
TTL expires_at DELETE
SETTINGS fsync_after_insert = 1;

CREATE TABLE IF NOT EXISTS highkey.logs
(
    product_id UUID,
    source_id UUID,
    log_id String,
    timestamp DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    level Enum8('trace' = 1, 'debug' = 2, 'info' = 3, 'warn' = 4, 'error' = 5, 'fatal' = 6),
    message String,
    service LowCardinality(String),
    environment LowCardinality(Nullable(String)),
    trace_id Nullable(String),
    span_id Nullable(String),
    request_id Nullable(String),
    attributes JSON,
    expires_at DateTime('UTC'),
    dedup_version UInt64 MATERIALIZED bitNot(toUInt64(toUnixTimestamp64Milli(received_at))),
    INDEX log_id_bloom log_id TYPE bloom_filter GRANULARITY 1,
    INDEX received_at_minmax received_at TYPE minmax GRANULARITY 1,
    INDEX message_ngrams lower(message) TYPE ngrambf_v1(3, 32768, 3, 0) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(dedup_version)
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (product_id, toDate(timestamp), service, log_id)
TTL expires_at DELETE
SETTINGS fsync_after_insert = 1;

-- The dashboard mirrors keys here from SQLite; the ingest app only reads it.
CREATE TABLE IF NOT EXISTS highkey.ingest_keys
(
    hash String,
    kind Enum8('events' = 1, 'logs' = 2),
    product_id UUID,
    source_id UUID,
    allowed_origins Array(String),
    retention_days UInt16,
    revoked UInt8,
    updated_at DateTime64(3, 'UTC')
)
ENGINE = EmbeddedRocksDB
PRIMARY KEY hash;

CREATE TABLE IF NOT EXISTS highkey.ingest_contract (version UInt32) ENGINE = MergeTree ORDER BY version;

INSERT INTO highkey.ingest_contract
SELECT 1 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version = 1) = 0;

-- The definer of every project's views. It cannot log in.
CREATE USER IF NOT EXISTS highkey_definer IDENTIFIED WITH no_password HOST NONE;

GRANT SELECT ON highkey.events TO highkey_definer;

GRANT SELECT ON highkey.logs TO highkey_definer;

-- Every project reader uses this profile. Readers can change only the run's scope and lower
-- their own time limit.
CREATE SETTINGS PROFILE OR REPLACE highkey_reader SETTINGS
    readonly = 1,
    max_execution_time = 10 MIN 1 MAX 10 CHANGEABLE_IN_READONLY,
    max_memory_usage = 1073741824 MAX 1073741824,
    max_threads = 2 MAX 2,
    max_result_rows = 10000 MAX 10000,
    max_result_bytes = 4194304 MAX 4194304,
    result_overflow_mode = 'throw' CONST,
    allow_ddl = 0 CONST,
    allow_introspection_functions = 0 CONST,
    max_concurrent_queries_for_user = 4 MAX 4,
    SQL_highkey_from = 0 CHANGEABLE_IN_READONLY,
    SQL_highkey_to = 0 CHANGEABLE_IN_READONLY,
    SQL_highkey_source = '' CHANGEABLE_IN_READONLY,
    SQL_highkey_bucket = 'day' CHANGEABLE_IN_READONLY;

-- The start of the run's bucket (SQL_highkey_bucket) containing a time. Weeks start on Monday.
CREATE FUNCTION IF NOT EXISTS bucket AS (t) -> multiIf(
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'hour', toDateTime64(toStartOfHour(toDateTime64(t, 3, 'UTC')), 3, 'UTC'),
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'week', toDateTime64(toStartOfWeek(toDateTime64(t, 3, 'UTC'), 1), 3, 'UTC'),
    getSettingOrDefault('SQL_highkey_bucket', 'day') = 'month', toDateTime64(toStartOfMonth(toDateTime64(t, 3, 'UTC')), 3, 'UTC'),
    toDateTime64(toStartOfDay(toDateTime64(t, 3, 'UTC')), 3, 'UTC')
);
