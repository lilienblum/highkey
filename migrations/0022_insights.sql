CREATE TABLE daily_insights (
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, day_ms INTEGER NOT NULL,
 report TEXT NOT NULL, PRIMARY KEY(product_id,day_ms)
);
CREATE TABLE signal_last_seen (
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, source_id TEXT NOT NULL,
 kind TEXT NOT NULL, service TEXT NOT NULL, seen_ms INTEGER NOT NULL,
 PRIMARY KEY(product_id,source_id,kind,service)
);
