-- Only an explicit identify with a visitor and session can link earlier events.
CREATE TABLE IF NOT EXISTS highkey.session_profiles
(
  product_id UUID, source_id UUID, actor_id String, session_id String,
  event_id String, event_time DateTime64(3,'UTC'), received_at DateTime64(3,'UTC'),
  profile_id String, expires_at DateTime('UTC'),
  dedup_version UInt64 MATERIALIZED bitNot(toUInt64(toUnixTimestamp64Milli(received_at)))
)
ENGINE = ReplacingMergeTree(dedup_version)
PARTITION BY toYYYYMM(event_time)
ORDER BY (product_id,source_id,session_id,actor_id,event_time,event_id)
TTL expires_at DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS highkey.capture_session_profiles TO highkey.session_profiles AS
SELECT product_id,source_id,assumeNotNull(e.actor_id) AS actor_id,assumeNotNull(e.session_id) AS session_id,
  event_id,event_time,received_at,assumeNotNull(e.profile_id) AS profile_id,expires_at
FROM highkey.events AS e WHERE record_type='identify' AND identity_kind='visitor'
  AND e.actor_id IS NOT NULL AND e.session_id IS NOT NULL AND e.profile_id IS NOT NULL;

INSERT INTO highkey.session_profiles
SELECT product_id,source_id,assumeNotNull(actor_id),assumeNotNull(session_id),event_id,event_time,received_at,assumeNotNull(profile_id),expires_at
FROM highkey.events WHERE record_type='identify' AND identity_kind='visitor' AND actor_id IS NOT NULL AND session_id IS NOT NULL AND profile_id IS NOT NULL AND expires_at > now();

GRANT SELECT ON highkey.session_profiles TO highkey_definer;
