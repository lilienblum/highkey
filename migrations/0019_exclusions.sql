CREATE TABLE collection_exclusions (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  policy TEXT NOT NULL
);
