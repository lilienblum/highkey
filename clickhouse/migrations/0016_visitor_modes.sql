CREATE TABLE IF NOT EXISTS highkey.visitor_policies (
  hash String, product_id UUID, mode LowCardinality(String)
) ENGINE=EmbeddedRocksDB PRIMARY KEY hash;

-- Old ingest versions still write the three ordinary columns explicitly. A new writer instead
-- provides transient explicit IDs, or a day-only salt and an optional in-memory session nonce.
ALTER TABLE highkey.events
  ADD COLUMN IF NOT EXISTS sent_actor String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS sent_kind String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS sent_session String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS day_salt String EPHEMERAL,
  ADD COLUMN IF NOT EXISTS visit_nonce String EPHEMERAL,
  MODIFY COLUMN actor_id Nullable(String) DEFAULT if(day_salt!='' AND request_ip!='' AND request_ua!='',
    lower(hex(SHA256(concat(day_salt,'|',toString(product_id),'|',toString(source_id),'|',request_ip,'|',request_ua)))),nullIf(sent_actor,'')),
  MODIFY COLUMN identity_kind LowCardinality(Nullable(String)) DEFAULT if(day_salt!='' AND request_ip!='' AND request_ua!='','visitor',nullIf(sent_kind,'')),
  MODIFY COLUMN session_id Nullable(String) DEFAULT if(day_salt!='' AND request_ip!='' AND request_ua!='' AND visit_nonce!='',
    lower(hex(SHA256(concat(day_salt,'|',toString(product_id),'|',toString(source_id),'|visit|',visit_nonce)))),nullIf(sent_session,''));

INSERT INTO highkey.ingest_contract
SELECT 6 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version = 6) = 0;
