CREATE TABLE analysis_views (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  definition TEXT NOT NULL,
  UNIQUE(product_id,name)
);
