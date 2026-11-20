ALTER TABLE ingestion_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'public' CHECK (kind IN ('public', 'server'));

CREATE TABLE revenue_settings (
    product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    allow_browser_revenue INTEGER NOT NULL DEFAULT 0 CHECK (allow_browser_revenue IN (0, 1))
);
