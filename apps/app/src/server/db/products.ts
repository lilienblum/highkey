// Projects, with their sources and sidebar links as the API returns them.
import { createHash } from "node:crypto";
import { bad, projectMissing } from "../api/errors";
import { normalizeWebsites } from "../website";
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
  website_urls: string[];
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
  website_urls?: string[];
}

const ROW =
  "id, name, retention_days, created_at, website_url, website_urls, favicon_version, slug";

type Row = Omit<Product, "sources" | "dashboards" | "views" | "website_urls"> & {
  website_urls: string | null;
};

async function withLinks(db: Db, row: Row): Promise<Product> {
  return {
    ...row,
    website_urls: row.website_urls
      ? JSON.parse(row.website_urls)
      : row.website_url
        ? [row.website_url]
        : [],
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

/**
 * An organization's projects (never deleted ones), or (without `orgId`) every project, deleted ones
 * included, for background work.
 */
export async function products(db: Db, orgId?: string, allowed?: string[]): Promise<Product[]> {
  if (allowed?.length === 0) return [];
  const rows =
    orgId === undefined
      ? await all<Row>(db, `SELECT ${ROW} FROM products ORDER BY created_at, id`)
      : await all<Row>(
          db,
          `SELECT ${ROW} FROM products WHERE org_id = ? AND deleted_at IS NULL ${allowed ? "AND id IN (SELECT value FROM json_each(?))" : ""} ORDER BY created_at, id`,
          allowed ? [orgId, JSON.stringify(allowed)] : [orgId],
        );
  return Promise.all(rows.map((row) => withLinks(db, row)));
}

export async function requireProduct(db: Db, id: string): Promise<void> {
  if (!(await one(db, "SELECT 1 AS found FROM products WHERE id = ?", [id])))
    throw projectMissing();
}

/**
 * A project by id, or else by slug, within organization `orgId`: another organization's project,
 * or a deleted one, is missing, exactly like one that does not exist. Without `orgId` (background work only) any
 * project matches by id.
 */
export async function resolveProduct(db: Db, key: string, orgId?: string): Promise<Row> {
  const row =
    orgId === undefined
      ? await one<Row>(db, `SELECT ${ROW} FROM products WHERE id = ?`, [key])
      : ((await one<Row>(
          db,
          `SELECT ${ROW} FROM products WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
          [key, orgId],
        )) ??
        (await one<Row>(
          db,
          `SELECT ${ROW} FROM products WHERE slug = ? AND org_id = ? AND deleted_at IS NULL`,
          [key, orgId],
        )));
  if (!row) throw projectMissing();
  return row;
}

export function validateProduct(input: ProductInput): void {
  if (input.website_urls !== undefined && input.website_url != null)
    throw bad("Send website_urls or website_url, not both");
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
  orgId: string | null = null,
): Promise<Product> {
  validateProduct(input);
  const previous = id ? await product(db, id) : null;
  const websites =
    input.website_urls !== undefined
      ? normalizeWebsites(input.website_urls)
      : input.website_url != null
        ? normalizeWebsites(input.website_url.trim() ? [input.website_url] : [])
        : (previous?.website_urls ?? []);
  const website = websites.find((url) => !url.includes("*")) ?? null;
  const productId = id ?? newId();
  await db.transaction(async (tx) => {
    if (previous) {
      await tx.execute(
        "UPDATE products SET name = ?2, retention_days = ?3, website_url = ?4, website_urls = ?5, favicon = CASE WHEN website_url IS ?4 THEN favicon ELSE NULL END, favicon_version = CASE WHEN website_url IS ?4 THEN favicon_version ELSE NULL END WHERE id = ?1",
        [productId, input.name.trim(), input.retention_days, website, JSON.stringify(websites)],
      );
    } else {
      const base = projectSlug(input.name);
      let slug = base;
      for (let suffix = 1; ; suffix++) {
        // Slugs are unique within an organization; there, the unique index arbitrates.
        const inserted = await changes(
          tx,
          "INSERT INTO products(id, name, retention_days, created_at, website_url, slug, org_id, website_urls) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug = ?6 AND org_id IS ?7) ON CONFLICT DO NOTHING",
          [
            productId,
            input.name.trim(),
            input.retention_days,
            now(),
            website,
            slug,
            orgId,
            JSON.stringify(websites),
          ],
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

/**
 * Moves a project to organization `orgId` with everything that hangs off it (sources, keys,
 * dashboards, views). It keeps its slug unless the target has one; then it takes the next free one.
 */
export async function moveProduct(db: Db, id: string, orgId: string): Promise<Product> {
  await db.transaction(async (tx) => {
    const row = await one<{ name: string; slug: string; org_id: string | null }>(
      tx,
      "SELECT name, slug, org_id FROM products WHERE id = ?",
      [id],
    );
    if (!row) throw projectMissing();
    if (row.org_id === orgId) return;
    const base = projectSlug(row.name);
    for (let suffix = 1, slug = row.slug; ; slug = `${base}-${suffix++}`) {
      const moved = await changes(
        tx,
        "UPDATE OR IGNORE products SET org_id = ?2, slug = ?3 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM products WHERE slug = ?3 AND org_id = ?2)",
        [id, orgId, slug],
      );
      if (moved === 1) return;
    }
  });
  return product(db, id);
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

/** Gives projects that belong to no organization to `orgId` (the first account's, on upgrade). */
export async function adoptOrphanProjects(db: Db, orgId: string): Promise<number> {
  return changes(db, "UPDATE products SET org_id = ? WHERE org_id IS NULL", [orgId]);
}
