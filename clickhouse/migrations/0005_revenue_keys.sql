-- The sidecar leaves the original EmbeddedRocksDB registry readable by older ingest builds.
CREATE TABLE IF NOT EXISTS highkey.ingest_key_policies
(
    hash String,
    product_id UUID,
    server_key UInt8,
    allow_browser_revenue UInt8
)
ENGINE = EmbeddedRocksDB
PRIMARY KEY hash;

INSERT INTO highkey.ingest_contract
SELECT 3 FROM system.one WHERE (SELECT count() FROM highkey.ingest_contract WHERE version = 3) = 0;
