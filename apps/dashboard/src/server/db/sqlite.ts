// The dashboard's management store: projects, sources, keys, log settings, dashboards and
// views. Short synchronous transactions; analytics live in ClickHouse.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, retention_days INTEGER NOT NULL, created_at TEXT NOT NULL,
  website_url TEXT, favicon BLOB, favicon_version TEXT, slug TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL COLLATE NOCASE, icon TEXT, created_at TEXT NOT NULL, slug TEXT NOT NULL,
  UNIQUE(product_id, name), UNIQUE(product_id, slug));
CREATE TABLE IF NOT EXISTS ingestion_keys(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT NOT NULL REFERENCES sources(id), label TEXT NOT NULL, prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  allowed_origins TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log_settings(
  product_id TEXT PRIMARY KEY REFERENCES products(id), retention_days INTEGER NOT NULL DEFAULT 7);
CREATE TABLE IF NOT EXISTS log_keys(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  source_id TEXT NOT NULL REFERENCES sources(id), label TEXT NOT NULL, prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS dashboards(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id, slug));
CREATE TABLE IF NOT EXISTS dashboard_revisions(
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  document TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('dashboard','mcp','api')),
  created_at TEXT NOT NULL, PRIMARY KEY(dashboard_id, revision));
CREATE TABLE IF NOT EXISTS views(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('events','logs')), slug TEXT NOT NULL, name TEXT NOT NULL,
  document TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(product_id, kind, slug));
`;

export class Store {
  private constructor(readonly db: Database) {}

  static open(path: string): Store {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
    if (user_version > SCHEMA_VERSION)
      throw new Error("The management database is newer than this dashboard supports");
    if (user_version < SCHEMA_VERSION) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      })();
    }
    return new Store(db);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  close(): void {
    this.db.close();
  }
}

export function now(): string {
  return new Date().toISOString();
}

/** A time-ordered id, as the Rust API made with UUIDv7. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
