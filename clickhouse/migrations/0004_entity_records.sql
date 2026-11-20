-- Mutation records remain append-only; the reader folds sets and increments in event order.
-- The source event log supplies product-scoped deduplication before these materialized views run.
CREATE TABLE IF NOT EXISTS highkey.profiles
(
    product_id UUID,
    source_id UUID,
    event_id String,
    profile_id String,
    session_id Nullable(String),
    event_time DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    traits JSON,
    increments JSON,
    expires_at DateTime('UTC')
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(event_time)
ORDER BY (product_id, profile_id, event_id)
TTL expires_at DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS highkey.capture_profiles TO highkey.profiles AS
SELECT product_id, source_id, event_id, assumeNotNull(profile_id) AS profile_id, session_id,
    event_time, received_at, traits, increments, expires_at
FROM highkey.events WHERE record_type = 'identify' AND profile_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS highkey.groups
(
    product_id UUID,
    source_id UUID,
    event_id String,
    group_type String,
    group_id String,
    group_name String,
    event_time DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    traits JSON,
    increments JSON,
    expires_at DateTime('UTC')
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(event_time)
ORDER BY (product_id, group_type, group_id, event_id)
TTL expires_at DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS highkey.capture_groups TO highkey.groups AS
SELECT product_id, source_id, event_id, group_type, group_id, group_name,
    event_time, received_at, traits, increments, expires_at
FROM highkey.events WHERE record_type = 'group';

GRANT SELECT ON highkey.profiles TO highkey_definer;

GRANT SELECT ON highkey.groups TO highkey_definer;

-- Raw JSON scalars preserve strings and booleans while numeric increments remain numeric.
CREATE FUNCTION IF NOT EXISTS highkey_apply_traits AS (previous, sets, increments) ->
    arrayFold(
        (values, pair) -> mapUpdate(values, map(pair.1, toJSONString(toFloat64OrZero(values[pair.1]) + toFloat64OrZero(pair.2)))),
        JSONExtractKeysAndValuesRaw(increments),
        mapUpdate(previous, mapFromArrays(
            arrayMap(pair -> pair.1, JSONExtractKeysAndValuesRaw(sets)),
            arrayMap(pair -> pair.2, JSONExtractKeysAndValuesRaw(sets))
        ))
    );
