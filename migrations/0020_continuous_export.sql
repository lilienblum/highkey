CREATE TABLE export_streams (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK(signal IN ('events','logs')),
  enabled INTEGER NOT NULL, cursor_ms INTEGER NOT NULL, cursor_id TEXT NOT NULL DEFAULT '',
  pending_key TEXT, pending_bytes BLOB, pending_ms INTEGER, pending_id TEXT, updated_ms INTEGER,
  PRIMARY KEY(product_id,signal)
);
