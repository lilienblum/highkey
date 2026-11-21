CREATE TABLE chart_references (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  at_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX chart_references_range ON chart_references(product_id, at_ms, id);
