ALTER TABLE highkey.session_events
  ADD COLUMN IF NOT EXISTS country LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS region LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS device LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS browser LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS browser_version LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS os_family LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS os_version LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS acquisition_type LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS bot LowCardinality(String) DEFAULT '';

ALTER TABLE highkey.capture_sessions MODIFY QUERY
WITH coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents
SELECT product_id,source_id,assumeNotNull(e.actor_id) AS actor_id,assumeNotNull(e.session_id) AS session_id,
  event_id,event_time,received_at,backfill,CAST(name='page_view','Bool') AS is_page,ifNull(properties.path.:String,'') AS path,
  referrer_name AS referrer,highkey_campaign(properties.utm_source.:String,properties.utm_medium.:String,properties.utm_campaign.:String,properties.utm_term.:String,properties.utm_content.:String) AS campaign,
  profile_id,if(abs(cents)<=9007199254740991,toInt64(cents),0) AS revenue_cents,expires_at,
  geo.1 AS country,geo.2 AS region,device,browser,browser_version,os_family,os_version,referrer_type AS acquisition_type,bot
FROM highkey.events AS e WHERE record_type='event' AND identity_kind='visitor' AND e.actor_id IS NOT NULL AND e.session_id IS NOT NULL;

CREATE OR REPLACE VIEW highkey.sessions AS
SELECT product_id,source_id,actor_id,session_id,
  minIf(event_time,NOT backfill) AS started_at,maxIf(event_time,NOT backfill) AS ended_at,
  argMinIf(path,tuple(event_time,event_id),is_page AND NOT backfill AND path != '') AS entry_page,
  argMaxIf(path,tuple(event_time,event_id),is_page AND NOT backfill AND path != '') AS exit_page,
  countIf(is_page) AS page_views,count() AS events,
  dateDiff('millisecond',started_at,ended_at) AS duration_ms,page_views=1 AS bounced,
  argMinIf(referrer,tuple(event_time,event_id),NOT backfill) AS first_referrer,
  argMinIf(campaign,tuple(event_time,event_id),NOT backfill) AS first_campaign,
  argMinIf(tuple(country,region,device,browser,browser_version,os_family,os_version,acquisition_type),tuple(event_time,event_id),NOT backfill) AS context,
  argMax(profile_id,tuple(event_time,event_id)) AS profile,sum(toInt128(revenue_cents)) AS net_cents
FROM highkey.session_events FINAL WHERE expires_at>now() AND bot=''
GROUP BY product_id,source_id,actor_id,session_id HAVING countIf(NOT backfill)>0;

INSERT INTO highkey.ingest_contract
SELECT 5 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version = 5) = 0;
