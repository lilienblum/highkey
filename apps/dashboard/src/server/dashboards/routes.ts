// Dashboard routes: reads on /api/read, writes on the management prefix. Writes are throttled,
// then checked, then saved, and each one tells open dashboards through the dashboards signal.
import { fields, readJson } from "../api/body";
import type { ApiContext } from "../api/context";
import { json, noContent } from "../api/errors";
import { route } from "../api/router";
import { resolveProduct } from "../db/products";
import schema from "./dashboard.v1.schema.json";
import { conflict, invalid, rateLimited } from "./errors";
import type { Document } from "./spec";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  listRevisions,
  type Origin,
  originFrom,
  restoreDashboard,
  revisionDocument,
  type Stored,
  updateDashboard,
} from "./storage";
import { checkDocument, parseDocument, type Report } from "./validate";

export interface SaveChecks {
  timings: unknown[];
  warnings: unknown[];
}

/** What a save runs before it writes: SQL verification and the benchmark (see sql.ts, bench.ts). */
export type BeforeSave = (
  ctx: ApiContext,
  product: string,
  doc: Document,
  previous: Document | null,
) => Promise<SaveChecks>;
let beforeSave: BeforeSave = async () => ({ timings: [], warnings: [] });
export function setBeforeSave(check: BeforeSave): void {
  beforeSave = check;
}

/** Extra validation a validate request runs after the rules: catalog warnings and SQL. */
export type ValidateExtras = (
  ctx: ApiContext,
  product: string,
  doc: Document,
  report: Report,
) => Promise<void>;
let validateExtras: ValidateExtras = async () => {};
export function setValidateExtras(extras: ValidateExtras): void {
  validateExtras = extras;
}

export function throttle(ctx: ApiContext, product: string): void {
  const wait = ctx.writeLimit.take(product);
  if (wait !== null) throw rateLimited(wait);
}

export function document(value: unknown): Document {
  const parsed = parseDocument(value);
  if (!parsed.ok) throw invalid(parsed.report);
  return parsed.value;
}

const saved = (stored: Stored, checks: SaveChecks) => ({
  ...stored,
  bench: checks.timings,
  warnings: checks.warnings,
});

export async function createFor(ctx: ApiContext, product: string, value: unknown, origin: Origin) {
  throttle(ctx, product);
  const doc = document(value);
  const checks = await beforeSave(ctx, product, doc, null);
  const stored = createDashboard(ctx.store, product, doc, origin);
  ctx.changes.notify(product, "dashboards");
  return saved(stored, checks);
}

export async function updateFor(
  ctx: ApiContext,
  product: string,
  key: string,
  baseRevision: number,
  value: unknown,
  origin: Origin,
) {
  throttle(ctx, product);
  const doc = document(value);
  const current = getDashboard(ctx.store, product, key);
  if (current.revision !== baseRevision) throw conflict(current.revision);
  const checks = await beforeSave(ctx, product, doc, current.document);
  const stored = updateDashboard(ctx.store, product, key, baseRevision, doc, origin);
  ctx.changes.notify(product, "dashboards");
  return saved(stored, checks);
}

export async function restoreFor(
  ctx: ApiContext,
  product: string,
  key: string,
  revision: number,
  origin: Origin,
) {
  throttle(ctx, product);
  const doc = revisionDocument(ctx.store, product, key, revision);
  const current = getDashboard(ctx.store, product, key);
  const checks = await beforeSave(ctx, product, doc, current.document);
  const stored = restoreDashboard(ctx.store, product, key, revision, origin);
  ctx.changes.notify(product, "dashboards");
  return saved(stored, checks);
}

export async function removeFor(ctx: ApiContext, product: string, key: string) {
  throttle(ctx, product);
  deleteDashboard(ctx.store, product, key);
  ctx.changes.notify(product, "dashboards");
}

export async function validateFor(ctx: ApiContext, project: string, value: unknown) {
  const product = resolveProduct(ctx.store, project).id;
  const parsed = parseDocument(value);
  let report: Report;
  if (parsed.ok) {
    report = checkDocument(parsed.value);
    await validateExtras(ctx, product, parsed.value, report);
  } else report = parsed.report;
  return { valid: report.errors.length === 0, errors: report.errors, warnings: report.warnings };
}

export function registerDashboards(): void {
  const read = "/api/read/products/:project/dashboards";
  route("GET", "/api/read/schemas/dashboard.v1.json", async () => json(schema));
  route("GET", read, async (_r, ctx, { project }) =>
    json(listDashboards(ctx.store, resolveProduct(ctx.store, project as string).id)),
  );
  route("POST", `${read}/validate`, async (request, ctx, { project }) => {
    const { document: value } = fields(await readJson(request), { document: "unknown" });
    return json(await validateFor(ctx, project as string, value));
  });
  route("GET", `${read}/:key`, async (_r, ctx, { project, key }) =>
    json(getDashboard(ctx.store, resolveProduct(ctx.store, project as string).id, key as string)),
  );
  route("GET", `${read}/:key/revisions`, async (_r, ctx, { project, key }) =>
    json(listRevisions(ctx.store, resolveProduct(ctx.store, project as string).id, key as string)),
  );
  const write = "/api/products/:id/dashboards";
  route("POST", write, async (request, ctx, { id }) => {
    const { document: value } = fields(await readJson(request), { document: "unknown" });
    return json(await createFor(ctx, id as string, value, originFrom(request)));
  });
  route("PUT", `${write}/:key`, async (request, ctx, { id, key }) => {
    const input = fields(await readJson(request), {
      base_revision: "integer",
      document: "unknown",
    });
    return json(
      await updateFor(
        ctx,
        id as string,
        key as string,
        input.base_revision,
        input.document,
        originFrom(request),
      ),
    );
  });
  route("DELETE", `${write}/:key`, async (_r, ctx, { id, key }) => {
    await removeFor(ctx, id as string, key as string);
    return noContent();
  });
  route("POST", `${write}/:key/revisions/:n/restore`, async (request, ctx, { id, key, n }) =>
    json(await restoreFor(ctx, id as string, key as string, Number(n), originFrom(request))),
  );
}
