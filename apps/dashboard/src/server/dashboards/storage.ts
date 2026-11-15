// Dashboard documents and their revisions, in SQLite. Every write validates the document, runs
// in one immediate transaction, bumps `revision` with a compare-and-set, and records a revision.
import { requireProduct } from "../db/products";
import { projectSlug } from "../db/sources";
import { newId, now, type Store } from "../db/sqlite";
import { conflict, invalid, limit, notFound } from "./errors";
import type { Document } from "./spec";
import { missingHint } from "./suggest";
import { checkDocument, Limits, serializeDocument } from "./validate";

export type Origin = "dashboard" | "mcp" | "api";

/** `X-Piko-Origin: dashboard` marks writes made from the dashboard UI. */
export function originFrom(request: Request): Origin {
  return request.headers.get("x-piko-origin") === "dashboard" ? "dashboard" : "api";
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

function unknown(store: Store, product: string, key: string) {
  const slugs = (
    store.db
      .query("SELECT slug FROM dashboards WHERE product_id = ? ORDER BY slug")
      .all(product) as { slug: string }[]
  ).map((r) => r.slug);
  return notFound("Dashboard", missingHint(key, slugs, "dashboards"));
}

function validated(doc: Document): string {
  const report = checkDocument(doc);
  if (!report.ok) throw invalid(report);
  return serializeDocument(doc);
}

function immediate<T>(store: Store, work: () => T): T {
  return store.db.transaction(work).immediate();
}

function resolve(store: Store, product: string, key: string): { id: string; revision: number } {
  const row = store.db
    .query(
      "SELECT id, revision FROM dashboards WHERE product_id = ?1 AND (id = ?2 OR slug = ?2) ORDER BY id = ?2 DESC LIMIT 1",
    )
    .get(product, key) as { id: string; revision: number } | null;
  if (!row) throw unknown(store, product, key);
  return row;
}

function load(store: Store, id: string): Stored {
  const row = store.db
    .query("SELECT id, slug, revision, updated_at, document FROM dashboards WHERE id = ?")
    .get(id) as Omit<Stored, "document"> & { document: string };
  return { ...row, document: JSON.parse(row.document) };
}

export function listDashboards(store: Store, product: string) {
  requireProduct(store, product);
  const rows = store.db
    .query(
      "SELECT id, slug, name, revision, updated_at, document FROM dashboards WHERE product_id = ? ORDER BY name COLLATE NOCASE, name, id",
    )
    .all(product) as {
    id: string;
    slug: string;
    name: string;
    revision: number;
    updated_at: string;
    document: string;
  }[];
  return rows.map(({ document, ...row }) => {
    const doc = JSON.parse(document) as Document;
    return { ...row, description: doc.description ?? null, widgets: doc.widgets.length };
  });
}

export function getDashboard(store: Store, product: string, key: string): Stored {
  requireProduct(store, product);
  return load(store, resolve(store, product, key).id);
}

const RESERVED_SLUGS = ["validate"];

function dashboardSlug(name: string): string {
  return /[A-Za-z0-9]/.test(name) ? projectSlug(name) : "dashboard";
}

export function createDashboard(
  store: Store,
  product: string,
  doc: Document,
  origin: Origin,
): Stored {
  const json = validated(doc);
  requireProduct(store, product);
  return immediate(store, () => {
    const { n } = store.db
      .query("SELECT count(*) AS n FROM dashboards WHERE product_id = ?")
      .get(product) as { n: number };
    if (n >= Limits.MAX_DASHBOARDS_PER_PROJECT)
      throw limit(`A project holds at most ${Limits.MAX_DASHBOARDS_PER_PROJECT} dashboards`);
    const id = newId();
    const at = now();
    const base = dashboardSlug(doc.name);
    let slug = base;
    for (let suffix = 2; ; suffix++) {
      // A reserved slug counts as taken: GET …/dashboards/validate must never reach a dashboard.
      const inserted = RESERVED_SLUGS.includes(slug)
        ? 0
        : store.db
            .query(
              "INSERT INTO dashboards(id, product_id, slug, name, document, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6) ON CONFLICT(product_id, slug) DO NOTHING",
            )
            .run(id, product, slug, doc.name, json, at).changes;
      if (inserted === 1) break;
      slug = `${base}-${suffix}`;
    }
    store.db
      .query(
        "INSERT INTO dashboard_revisions(dashboard_id, revision, document, origin, created_at) VALUES (?1, 1, ?2, ?3, ?4)",
      )
      .run(id, json, origin, at);
    return load(store, id);
  });
}

function save(
  store: Store,
  id: string,
  expected: number,
  doc: Document,
  json: string,
  origin: Origin,
): void {
  const at = now();
  const changed = store.db
    .query(
      "UPDATE dashboards SET name = ?1, document = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?4 AND revision = ?5",
    )
    .run(doc.name, json, at, id, expected).changes;
  if (changed === 0) {
    const { revision } = store.db.query("SELECT revision FROM dashboards WHERE id = ?").get(id) as {
      revision: number;
    };
    throw conflict(revision);
  }
  store.db
    .query(
      "INSERT INTO dashboard_revisions(dashboard_id, revision, document, origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .run(id, expected + 1, json, origin, at);
  // Keep the newest 50 revisions plus the newest revision of each origin.
  store.db
    .query(
      "DELETE FROM dashboard_revisions WHERE dashboard_id = ?1 AND revision NOT IN (SELECT revision FROM dashboard_revisions WHERE dashboard_id = ?1 ORDER BY revision DESC LIMIT ?2) AND revision NOT IN (SELECT max(revision) FROM dashboard_revisions WHERE dashboard_id = ?1 GROUP BY origin)",
    )
    .run(id, Limits.MAX_REVISIONS);
}

export function updateDashboard(
  store: Store,
  product: string,
  key: string,
  baseRevision: number,
  doc: Document,
  origin: Origin,
): Stored {
  const json = validated(doc);
  requireProduct(store, product);
  return immediate(store, () => {
    const { id } = resolve(store, product, key);
    save(store, id, baseRevision, doc, json, origin);
    return load(store, id);
  });
}

/** The document of one revision, as `restore` would write it. */
export function revisionDocument(
  store: Store,
  product: string,
  key: string,
  revision: number,
): Document {
  requireProduct(store, product);
  const { id } = resolve(store, product, key);
  const row = store.db
    .query("SELECT document FROM dashboard_revisions WHERE dashboard_id = ? AND revision = ?")
    .get(id, revision) as { document: string } | null;
  if (!row) throw revisionNotFound();
  return JSON.parse(row.document);
}

export function restoreDashboard(
  store: Store,
  product: string,
  key: string,
  revision: number,
  origin: Origin,
): Stored {
  requireProduct(store, product);
  return immediate(store, () => {
    const current = resolve(store, product, key);
    const row = store.db
      .query("SELECT document FROM dashboard_revisions WHERE dashboard_id = ? AND revision = ?")
      .get(current.id, revision) as { document: string } | null;
    if (!row) throw revisionNotFound();
    const doc = JSON.parse(row.document) as Document;
    save(store, current.id, current.revision, doc, validated(doc), origin);
    return load(store, current.id);
  });
}

export function deleteDashboard(store: Store, product: string, key: string): void {
  requireProduct(store, product);
  immediate(store, () => {
    const { id } = resolve(store, product, key);
    store.db.query("DELETE FROM dashboard_revisions WHERE dashboard_id = ?").run(id);
    store.db.query("DELETE FROM dashboards WHERE id = ?").run(id);
  });
}

export function listRevisions(store: Store, product: string, key: string) {
  requireProduct(store, product);
  const { id } = resolve(store, product, key);
  return store.db
    .query(
      "SELECT revision, origin, created_at FROM dashboard_revisions WHERE dashboard_id = ? ORDER BY revision DESC",
    )
    .all(id) as {
    revision: number;
    origin: Origin;
    created_at: string;
  }[];
}
