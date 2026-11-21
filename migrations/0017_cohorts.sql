CREATE TABLE cohorts (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  definition TEXT NOT NULL,
  revision INTEGER NOT NULL,
  checked_at INTEGER,
  member_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(product_id,name)
);
