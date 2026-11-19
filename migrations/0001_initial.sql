-- Highkey's management tables: projects, sources, keys, log settings, dashboards, revisions,
-- views and pending retention changes. Applied by Tako (or by Highkey without Tako); never edit
-- an applied migration, add a new numbered file instead.
CREATE TABLE products(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, retention_days INTEGER NOT NULL, created_at TEXT NOT NULL,
  website_url TEXT, favicon BLOB, favicon_version TEXT, slug TEXT NOT NULL UNIQUE);
CREATE TABLE sources(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL COLLATE NOCASE, icon TEXT, created_at TEXT NOT NULL, slug TEXT NOT NULL,
  UNIQUE(product_id, name), UNIQUE(product_id, slug));
CREATE TABLE ingestion_keys(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT NOT NULL REFERENCES sources(id), label TEXT NOT NULL, prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  allowed_origins TEXT NOT NULL DEFAULT '[]');
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE log_settings(
  product_id TEXT PRIMARY KEY REFERENCES products(id), retention_days INTEGER NOT NULL DEFAULT 7);
CREATE TABLE log_keys(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT NOT NULL REFERENCES sources(id), label TEXT NOT NULL, prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE dashboards(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id, slug));
CREATE TABLE dashboard_revisions(
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  document TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('dashboard','mcp','api')),
  created_at TEXT NOT NULL, PRIMARY KEY(dashboard_id, revision));
CREATE TABLE views(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('events','logs')), slug TEXT NOT NULL, name TEXT NOT NULL,
  document TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(product_id, kind, slug));
CREATE TABLE retention_changes(
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('events','logs')), due_ms INTEGER NOT NULL,
  final INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(product_id, signal));
