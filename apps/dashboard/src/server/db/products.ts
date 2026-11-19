// Projects, with their sources and sidebar links as the API returns them.
import { createHash } from "node:crypto";
import { bad, projectMissing } from "../api/errors";
import { normalizeWebsite } from "../website";
import { all, changes, type Db, one } from "./db";
import { listSources, projectSlug, type Source } from "./sources";
import { now, newId } from "./ids";

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

async function withLinks(db: Db, row: Row): Promise<Product> {
  return {
    ...row,
    sources: await listSources(db, row.id),
    dashboards: await all<Link>(
      db,
      "SELECT id, slug, name FROM dashboards WHERE product_id = ? ORDER BY name COLLATE NOCASE, name, id",
      [row.id],
    ),
    views: await all<Link & { kind: string }>(
      db,
      "SELECT id, slug, name, kind FROM views WHERE product_id = ? ORDER BY name COLLATE NOCASE, name, id",
      [row.id],
    ),
  };
}

/** A project's own row, without sources or links. */
export async function productRow(db: Db, id: string): Promise<Row> {
  const row = await one<Row>(db, `SELECT ${ROW} FROM products WHERE id = ?`, [id]);
  if (!row) throw projectMissing();
  return row;
}

export async function product(db: Db, id: string): Promise<Product> {
  return withLinks(db, await productRow(db, id));
}

export async function products(db: Db): Promise<Product[]> {
  const rows = await all<Row>(db, `SELECT ${ROW} FROM products ORDER BY created_at, id`);
  return Promise.all(rows.map((row) => withLinks(db, row)));
}

export async function requireProduct(db: Db, id: string): Promise<void> {
  if (!(await one(db, "SELECT 1 AS found FROM products WHERE id = ?", [id])))
    throw projectMissing();
}

/** A project by id, or else by slug. */
export async function resolveProduct(db: Db, key: string): Promise<Row> {
  const row =
    (await one<Row>(db, `SELECT ${ROW} FROM products WHERE id = ?`, [key])) ??
    (await one<Row>(db, `SELECT ${ROW} FROM products WHERE slug = ?`, [key]));
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

export async function saveProduct(
  db: Db,
  id: string | null,
  input: ProductInput,
): Promise<Product> {
  validateProduct(input);
  const previous = id ? await product(db, id) : null;
  const website =
    input.website_url !== undefined && input.website_url !== null
      ? normalizeWebsite(input.website_url)
      : (previous?.website_url ?? null);
  const productId = id ?? newId();
  await db.transaction(async (tx) => {
    if (previous) {
      await tx.execute(
        "UPDATE products SET name = ?2, retention_days = ?3, website_url = ?4, favicon = CASE WHEN website_url IS ?4 THEN favicon ELSE NULL END, favicon_version = CASE WHEN website_url IS ?4 THEN favicon_version ELSE NULL END WHERE id = ?1",
        [productId, input.name.trim(), input.retention_days, website],
      );
    } else {
      const base = projectSlug(input.name);
      let slug = base;
      for (let suffix = 2; ; suffix++) {
        // The unique index arbitrates concurrent creators.
        const inserted = await changes(
          tx,
          "INSERT INTO products(id, name, retention_days, created_at, website_url, slug) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING",
          [productId, input.name.trim(), input.retention_days, now(), website, slug],
        );
        if (inserted === 1) break;
        slug = `${base}-${suffix}`;
      }
    }
    await tx.execute(
      "INSERT OR IGNORE INTO sources(id, product_id, name, created_at, slug) VALUES (?1, ?1, 'Events', ?2, 'events')",
      [productId, now()],
    );
  });
  return product(db, productId);
}

/** Caches a fetched favicon, unless the project's website changed meanwhile. */
export async function cacheFavicon(
  db: Db,
  id: string,
  website: string,
  bytes: Uint8Array,
): Promise<Product> {
  const version = createHash("sha256").update(bytes).digest("hex");
  await db.execute(
    "UPDATE products SET favicon = ?, favicon_version = ? WHERE id = ? AND website_url = ?",
    [bytes, version, id, website],
  );
  return product(db, id);
}

export async function favicon(db: Db, id: string): Promise<Uint8Array | null> {
  const row = await one<{ favicon: Uint8Array | null }>(
    db,
    "SELECT favicon FROM products WHERE id = ?",
    [id],
  );
  return row?.favicon ?? null;
}
