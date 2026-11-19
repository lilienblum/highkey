// Dashboard documents and their revisions, in the management database. Every write validates the
// document, runs in one write transaction, bumps `revision` with a compare-and-set, and records a revision.
import { all, changes, type Db, one } from "../db/db";
import { requireProduct } from "../db/products";
import { projectSlug } from "../db/sources";
import { newId, now } from "../db/ids";
import { conflict, invalid, limit, notFound } from "./errors";
import type { Document } from "./spec";
import { missingHint } from "./suggest";
import { checkDocument, Limits, serializeDocument } from "./validate";

export type Origin = "dashboard" | "mcp" | "api";

/** `X-Highkey-Origin: dashboard` marks writes made from the dashboard UI. */
export function originFrom(request: Request): Origin {
  return request.headers.get("x-highkey-origin") === "dashboard" ? "dashboard" : "api";
}

export interface Stored {
  id: string;
  slug: string;
  revision: number;
  updated_at: string;
  document: Document;
}

const revisionNotFound = () =>
  notFound(
    "Revision",
    "Only the newest revisions are kept; list the dashboard's revisions for the numbers that exist",
  );

async function unknown(db: Db, product: string, key: string) {
  const slugs = (
    await all<{ slug: string }>(
      db,
      "SELECT slug FROM dashboards WHERE product_id = ? ORDER BY slug",
      [product],
    )
  ).map((r) => r.slug);
  return notFound("Dashboard", missingHint(key, slugs, "dashboards"));
}

function validated(doc: Document): string {
  const report = checkDocument(doc);
  if (!report.ok) throw invalid(report);
  return serializeDocument(doc);
}

async function resolve(
  db: Db,
  product: string,
  key: string,
): Promise<{ id: string; revision: number }> {
  const row = await one<{ id: string; revision: number }>(
    db,
    "SELECT id, revision FROM dashboards WHERE product_id = ?1 AND (id = ?2 OR slug = ?2) ORDER BY id = ?2 DESC LIMIT 1",
    [product, key],
  );
  if (!row) throw await unknown(db, product, key);
  return row;
}

async function load(db: Db, id: string): Promise<Stored> {
  const row = (await one<Omit<Stored, "document"> & { document: string }>(
    db,
    "SELECT id, slug, revision, updated_at, document FROM dashboards WHERE id = ?",
    [id],
  )) as Omit<Stored, "document"> & { document: string };
  return { ...row, document: JSON.parse(row.document) };
}

export async function listDashboards(db: Db, product: string) {
  await requireProduct(db, product);
  const rows = await all<{
    id: string;
    slug: string;
    name: string;
    revision: number;
    updated_at: string;
    document: string;
  }>(
    db,
    "SELECT id, slug, name, revision, updated_at, document FROM dashboards WHERE product_id = ? ORDER BY name COLLATE NOCASE, name, id",
    [product],
  );
  return rows.map(({ document, ...row }) => {
    const doc = JSON.parse(document) as Document;
    return { ...row, description: doc.description ?? null, widgets: doc.widgets.length };
  });
}

export async function getDashboard(db: Db, product: string, key: string): Promise<Stored> {
  await requireProduct(db, product);
  return load(db, (await resolve(db, product, key)).id);
}

const RESERVED_SLUGS = ["validate"];

function dashboardSlug(name: string): string {
  return /[A-Za-z0-9]/.test(name) ? projectSlug(name) : "dashboard";
}

export async function createDashboard(
  db: Db,
  product: string,
  doc: Document,
  origin: Origin,
): Promise<Stored> {
  const json = validated(doc);
  await requireProduct(db, product);
  return db.transaction(async (tx) => {
    const counted = await one<{ n: number }>(
      tx,
      "SELECT count(*) AS n FROM dashboards WHERE product_id = ?",
      [product],
    );
    if (Number(counted?.n ?? 0) >= Limits.MAX_DASHBOARDS_PER_PROJECT)
      throw limit(`A project holds at most ${Limits.MAX_DASHBOARDS_PER_PROJECT} dashboards`);
    const id = newId();
    const at = now();
    const base = dashboardSlug(doc.name);
    let slug = base;
    for (let suffix = 2; ; suffix++) {
      // A reserved slug counts as taken: GET …/dashboards/validate must never reach a dashboard.
      const inserted = RESERVED_SLUGS.includes(slug)
        ? 0
        : await changes(
            tx,
            "INSERT INTO dashboards(id, product_id, slug, name, document, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6) ON CONFLICT(product_id, slug) DO NOTHING",
            [id, product, slug, doc.name, json, at],
          );
      if (inserted === 1) break;
      slug = `${base}-${suffix}`;
    }
    await tx.execute(
      "INSERT INTO dashboard_revisions(dashboard_id, revision, document, origin, created_at) VALUES (?1, 1, ?2, ?3, ?4)",
      [id, json, origin, at],
    );
    return load(tx, id);
  });
}

async function save(
  tx: Db,
  id: string,
  expected: number,
  doc: Document,
  json: string,
  origin: Origin,
): Promise<void> {
  const at = now();
  // A compare-and-set on `revision`: of two saves on one base revision, only the first changes it.
  const changed = await changes(
    tx,
    "UPDATE dashboards SET name = ?1, document = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?4 AND revision = ?5",
    [doc.name, json, at, id, expected],
  );
  if (changed === 0) {
    const row = await one<{ revision: number }>(
      tx,
      "SELECT revision FROM dashboards WHERE id = ?",
      [id],
    );
    throw conflict(Number(row?.revision));
  }
  await tx.execute(
    "INSERT INTO dashboard_revisions(dashboard_id, revision, document, origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    [id, expected + 1, json, origin, at],
  );
  // Keep the newest 50 revisions plus the newest revision of each origin.
  await tx.execute(
    "DELETE FROM dashboard_revisions WHERE dashboard_id = ?1 AND revision NOT IN (SELECT revision FROM dashboard_revisions WHERE dashboard_id = ?1 ORDER BY revision DESC LIMIT ?2) AND revision NOT IN (SELECT max(revision) FROM dashboard_revisions WHERE dashboard_id = ?1 GROUP BY origin)",
    [id, Limits.MAX_REVISIONS],
  );
}

export async function updateDashboard(
  db: Db,
  product: string,
  key: string,
  baseRevision: number,
  doc: Document,
  origin: Origin,
): Promise<Stored> {
  const json = validated(doc);
  await requireProduct(db, product);
  return db.transaction(async (tx) => {
    const { id } = await resolve(tx, product, key);
    await save(tx, id, baseRevision, doc, json, origin);
    return load(tx, id);
  });
}

/** The document of one revision, as `restore` would write it. */
export async function revisionDocument(
  db: Db,
  product: string,
  key: string,
  revision: number,
): Promise<Document> {
  await requireProduct(db, product);
  const { id } = await resolve(db, product, key);
  const row = await one<{ document: string }>(
    db,
    "SELECT document FROM dashboard_revisions WHERE dashboard_id = ? AND revision = ?",
    [id, revision],
  );
  if (!row) throw revisionNotFound();
  return JSON.parse(row.document);
}

export async function restoreDashboard(
  db: Db,
  product: string,
  key: string,
  revision: number,
  origin: Origin,
): Promise<Stored> {
  await requireProduct(db, product);
  return db.transaction(async (tx) => {
    const current = await resolve(tx, product, key);
    const row = await one<{ document: string }>(
      tx,
      "SELECT document FROM dashboard_revisions WHERE dashboard_id = ? AND revision = ?",
      [current.id, revision],
    );
    if (!row) throw revisionNotFound();
    const doc = JSON.parse(row.document) as Document;
    await save(tx, current.id, current.revision, doc, validated(doc), origin);
    return load(tx, current.id);
  });
}

export async function deleteDashboard(db: Db, product: string, key: string): Promise<void> {
  await requireProduct(db, product);
  await db.transaction(async (tx) => {
    const { id } = await resolve(tx, product, key);
    await tx.execute("DELETE FROM dashboard_revisions WHERE dashboard_id = ?", [id]);
    await tx.execute("DELETE FROM dashboards WHERE id = ?", [id]);
  });
}

export async function listRevisions(db: Db, product: string, key: string) {
  await requireProduct(db, product);
  const { id } = await resolve(db, product, key);
  return all<{ revision: number; origin: Origin; created_at: string }>(
    db,
    "SELECT revision, origin, created_at FROM dashboard_revisions WHERE dashboard_id = ? ORDER BY revision DESC",
    [id],
  );
}
