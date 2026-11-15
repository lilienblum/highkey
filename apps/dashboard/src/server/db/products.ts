// Projects, with their sources and sidebar links as the API returns them.
import { createHash } from "node:crypto";
import { bad, projectMissing } from "../api/errors";
import { normalizeWebsite } from "../website";
import { listSources, projectSlug, type Source } from "./sources";
import { now, newId, type Store } from "./sqlite";

export interface Link {
  id: string;
  slug: string;
  name: string;
}

export interface Product {
  slug: string;
  website_url: string | null;
  favicon_version: string | null;
  id: string;
  name: string;
  retention_days: number;
  created_at: string;
  sources: Source[];
  dashboards: Link[];
  views: (Link & { kind: string })[];
}

export interface ProductInput {
  name: string;
  retention_days: number;
  website_url?: string | null;
}

const ROW = "id, name, retention_days, created_at, website_url, favicon_version, slug";

type Row = Omit<Product, "sources" | "dashboards" | "views">;

function withLinks(store: Store, row: Row): Product {
  return {
    ...row,
    sources: listSources(store, row.id),
    dashboards: store.db
      .query(
        "SELECT id, slug, name FROM dashboards WHERE product_id = ? ORDER BY name COLLATE NOCASE, name, id",
      )
      .all(row.id) as Link[],
    views: store.db
      .query(
        "SELECT id, slug, name, kind FROM views WHERE product_id = ? ORDER BY name COLLATE NOCASE, name, id",
      )
      .all(row.id) as (Link & { kind: string })[],
  };
}

/** A project's own row, without sources or links. */
export function productRow(store: Store, id: string): Row {
  const row = store.db.query(`SELECT ${ROW} FROM products WHERE id = ?`).get(id) as Row | null;
  if (!row) throw projectMissing();
  return row;
}

export function product(store: Store, id: string): Product {
  return withLinks(store, productRow(store, id));
}

export function products(store: Store): Product[] {
  return (store.db.query(`SELECT ${ROW} FROM products ORDER BY created_at, id`).all() as Row[]).map(
    (row) => withLinks(store, row),
  );
}

export function requireProduct(store: Store, id: string): void {
  if (!store.db.query("SELECT 1 FROM products WHERE id = ?").get(id)) throw projectMissing();
}

/** A project by id, or else by slug. */
export function resolveProduct(store: Store, key: string): Row {
  const row = (store.db.query(`SELECT ${ROW} FROM products WHERE id = ?`).get(key) ??
    store.db.query(`SELECT ${ROW} FROM products WHERE slug = ?`).get(key)) as Row | null;
  if (!row) throw projectMissing();
  return row;
}

export function validateProduct(input: ProductInput): void {
  if (input.website_url) normalizeWebsite(input.website_url);
  const size = new TextEncoder().encode(input.name).length;
  if (!input.name.trim() || size > 80) throw bad("Use a project name of 1–80 bytes");
  if (
    !Number.isInteger(input.retention_days) ||
    input.retention_days < 1 ||
    input.retention_days > 3650
  )
    throw bad("Use retention_days 1–3650");
}

export function saveProduct(store: Store, id: string | null, input: ProductInput): Product {
  validateProduct(input);
  const previous = id ? product(store, id) : null;
  const website =
    input.website_url !== undefined && input.website_url !== null
      ? normalizeWebsite(input.website_url)
      : (previous?.website_url ?? null);
  const productId = id ?? newId();
  store.transaction(() => {
    if (previous) {
      store.db
        .query(
          "UPDATE products SET name = ?2, retention_days = ?3, website_url = ?4, favicon = CASE WHEN website_url IS ?4 THEN favicon ELSE NULL END, favicon_version = CASE WHEN website_url IS ?4 THEN favicon_version ELSE NULL END WHERE id = ?1",
        )
        .run(productId, input.name.trim(), input.retention_days, website);
    } else {
      const base = projectSlug(input.name);
      let slug = base;
      for (let suffix = 2; ; suffix++) {
        // The unique index arbitrates concurrent creators.
        const inserted = store.db
          .query(
            "INSERT INTO products(id, name, retention_days, created_at, website_url, slug) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING",
          )
          .run(productId, input.name.trim(), input.retention_days, now(), website, slug).changes;
        if (inserted === 1) break;
        slug = `${base}-${suffix}`;
      }
    }
    store.db
      .query(
        "INSERT OR IGNORE INTO sources(id, product_id, name, created_at, slug) VALUES (?1, ?1, 'Events', ?2, 'events')",
      )
      .run(productId, now());
  });
  return product(store, productId);
}

/** Caches a fetched favicon, unless the project's website changed meanwhile. */
export function cacheFavicon(
  store: Store,
  id: string,
  website: string,
  bytes: Uint8Array,
): Product {
  const version = createHash("sha256").update(bytes).digest("hex");
  store.db
    .query("UPDATE products SET favicon = ?, favicon_version = ? WHERE id = ? AND website_url = ?")
    .run(bytes, version, id, website);
  return product(store, id);
}

export function favicon(store: Store, id: string): Uint8Array | null {
  const row = store.db.query("SELECT favicon FROM products WHERE id = ?").get(id) as {
    favicon: Uint8Array | null;
  } | null;
  return row?.favicon ?? null;
}
