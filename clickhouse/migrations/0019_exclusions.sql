CREATE TABLE IF NOT EXISTS highkey.collection_exclusions (
  product_id UUID, policy String
) ENGINE=EmbeddedRocksDB PRIMARY KEY product_id;

INSERT INTO highkey.ingest_contract
SELECT 7 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version=7)=0;
