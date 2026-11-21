-- One bounded sample per project/source/event/key/day. Values are JSON scalar literals so the
-- string "1" stays distinct from the number 1. Expire conservatively at the day's first expiry.
CREATE TABLE IF NOT EXISTS highkey.event_facets (
  product_id UUID, source_id UUID, day Date, name String, property String,
  samples AggregateFunction(groupUniqArray(32), String), expires_at SimpleAggregateFunction(min, DateTime('UTC'))
) ENGINE=AggregatingMergeTree PARTITION BY toYYYYMM(day)
ORDER BY (product_id,source_id,day,name,property) TTL toDateTime(expires_at,'UTC') DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS highkey.capture_event_facets TO highkey.event_facets AS
SELECT product_id,source_id,toDate(event_time) AS day,name,
  replaceAll(pair.1,'%2E','.') AS property, groupUniqArrayState(32)(if(length(pair.2)<=256,pair.2,'')) AS samples,
  toStartOfDay(expires_at) AS expires_at FROM highkey.events
ARRAY JOIN arrayPushBack(JSONExtractKeysAndValuesRaw(toJSONString(properties)),tuple('','')) AS pair
WHERE record_type='event' AND bot='' GROUP BY product_id,source_id,day,name,property,expires_at;

INSERT INTO highkey.event_facets
SELECT product_id,source_id,toDate(event_time) AS day,name,
  replaceAll(pair.1,'%2E','.') AS property, groupUniqArrayState(32)(if(length(pair.2)<=256,pair.2,'')) AS samples,
  toStartOfDay(expires_at) AS expires_at FROM highkey.events
ARRAY JOIN arrayPushBack(JSONExtractKeysAndValuesRaw(toJSONString(properties)),tuple('','')) AS pair
WHERE record_type='event' AND bot='' AND expires_at>now() GROUP BY product_id,source_id,day,name,property,expires_at;

GRANT SELECT ON highkey.event_facets TO highkey_definer;
