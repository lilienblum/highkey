-- One small contribution per identified session event. Keeping event-level expiry allows
-- retention changes to remove earlier pages without expiring the rest of a visit.
CREATE TABLE IF NOT EXISTS highkey.session_events
(
  product_id UUID, source_id UUID, actor_id String, session_id String,
  event_id String, event_time DateTime64(3,'UTC'), received_at DateTime64(3,'UTC'),
  backfill Bool, is_page Bool, path String, referrer String, campaign Map(String,String),
  profile_id Nullable(String), revenue_cents Int64, expires_at DateTime('UTC'),
  dedup_version UInt64 MATERIALIZED bitNot(toUInt64(toUnixTimestamp64Milli(received_at)))
)
ENGINE = ReplacingMergeTree(dedup_version)
PARTITION BY toYYYYMM(event_time)
ORDER BY (product_id,source_id,session_id,actor_id,event_id)
TTL expires_at DELETE;

CREATE OR REPLACE FUNCTION highkey_campaign AS (src,medium,campaign,term,content) ->
  mapFilter((k,v) -> v != '', map(
    'utm_source',ifNull(src,''),'utm_medium',ifNull(medium,''),
    'utm_campaign',ifNull(campaign,''),'utm_term',ifNull(term,''),'utm_content',ifNull(content,'')));

CREATE MATERIALIZED VIEW IF NOT EXISTS highkey.capture_sessions TO highkey.session_events AS
WITH coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents
SELECT product_id,source_id,assumeNotNull(e.actor_id) AS actor_id,assumeNotNull(e.session_id) AS session_id,
  event_id,event_time,received_at,backfill,CAST(name = 'page_view','Bool') AS is_page,
  ifNull(properties.path.:String,'') AS path,ifNull(properties.referrer.:String,'') AS referrer,
  highkey_campaign(properties.utm_source.:String,properties.utm_medium.:String,properties.utm_campaign.:String,properties.utm_term.:String,properties.utm_content.:String) AS campaign,profile_id,if(abs(cents)<=9007199254740991,toInt64(cents),0) AS revenue_cents,expires_at
FROM highkey.events AS e WHERE record_type = 'event' AND identity_kind = 'visitor' AND e.actor_id IS NOT NULL AND e.session_id IS NOT NULL;

INSERT INTO highkey.session_events
WITH coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents
SELECT product_id,source_id,assumeNotNull(actor_id),assumeNotNull(session_id),
  event_id,event_time,received_at,backfill,name = 'page_view',
  ifNull(properties.path.:String,''),ifNull(properties.referrer.:String,''),
  highkey_campaign(properties.utm_source.:String,properties.utm_medium.:String,properties.utm_campaign.:String,properties.utm_term.:String,properties.utm_content.:String),profile_id,if(abs(cents)<=9007199254740991,toInt64(cents),0),expires_at
FROM highkey.events WHERE record_type = 'event' AND identity_kind = 'visitor' AND actor_id IS NOT NULL AND session_id IS NOT NULL AND expires_at > now();

CREATE OR REPLACE VIEW highkey.sessions AS
SELECT product_id,source_id,actor_id,session_id,
  minIf(event_time,NOT backfill) AS started_at,maxIf(event_time,NOT backfill) AS ended_at,
  argMinIf(path,tuple(event_time,event_id),is_page AND NOT backfill AND path != '') AS entry_page,
  argMaxIf(path,tuple(event_time,event_id),is_page AND NOT backfill AND path != '') AS exit_page,
  countIf(is_page) AS page_views,count() AS events,
  dateDiff('millisecond',started_at,ended_at) AS duration_ms,page_views = 1 AS bounced,
  argMinIf(referrer,tuple(event_time,event_id),NOT backfill) AS first_referrer,
  argMinIf(campaign,tuple(event_time,event_id),NOT backfill) AS first_campaign,
  argMax(profile_id,tuple(event_time,event_id)) AS profile,
  sum(toInt128(revenue_cents)) AS net_cents
FROM highkey.session_events FINAL WHERE expires_at > now()
GROUP BY product_id,source_id,actor_id,session_id HAVING countIf(NOT backfill) > 0;

GRANT SELECT ON highkey.sessions TO highkey_definer;

GRANT SELECT ON highkey.session_events TO highkey_definer;
