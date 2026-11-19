-- Projects belong to an organization, and their slugs are unique within it rather than across the
-- server. SQLite cannot drop the old UNIQUE on slug in place, so products is rebuilt (SQLite's
-- documented procedure; other tables keep referencing products by name). Projects from before
-- organizations keep a NULL org_id until the first account's organization takes them in.
CREATE TABLE products_new(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, retention_days INTEGER NOT NULL, created_at TEXT NOT NULL,
  website_url TEXT, favicon BLOB, favicon_version TEXT, slug TEXT NOT NULL,
  org_id TEXT REFERENCES organization(id),
  UNIQUE(org_id, slug));
INSERT INTO products_new(id, name, retention_days, created_at, website_url, favicon, favicon_version, slug)
  SELECT id, name, retention_days, created_at, website_url, favicon, favicon_version, slug FROM products;
DROP TABLE products;
ALTER TABLE products_new RENAME TO products;
CREATE INDEX products_org_id ON products(org_id);
