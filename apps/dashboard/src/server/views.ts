// Saved views: a named, typed query for the Events page (`events`) or the Logs page (`logs`).
//
// A view is small and recreatable, so it has no revisions: a write replaces the document. Slugs
// are unique per project and kind, and a project holds at most 100 views of both kinds. A view
// holds only what its page can run. Ported from the Rust API's views.rs.
import { fields, readJson } from "./api/body";
import type { ApiContext } from "./api/context";
import { ApiError, json, noContent } from "./api/errors";
import { route } from "./api/router";
import schema from "./dashboards/dashboard.v1.schema.json";
import { detailed, invalid, limit, notFound } from "./dashboards/errors";
import { throttle } from "./dashboards/routes";
import { SchemaParser, ShapeError } from "./dashboards/shape";
import type { EventsQuery, LogFilter } from "./dashboards/spec";
import { missingHint } from "./dashboards/suggest";
import {
  checkEvents,
  checkLogs,
  Limits,
  type Parsed,
  Report,
  serialize,
  textLength,
} from "./dashboards/validate";
import { requireProductSync, resolveProduct } from "./db/products";
import { projectSlug } from "./db/sources";
import { newId, now, type Store } from "./db/sqlite";
import { EVENTS_PAGE_OPS, MEASURES } from "./queries/events";

/** Views per project, across both kinds. */
export const MAX_VIEWS_PER_PROJECT = 100;
/** Slugs that collide with a static route segment under `/views`. */
const RESERVED_SLUGS = ["validate"];

export type ViewKind = "events" | "logs";
const KINDS: ViewKind[] = ["events", "logs"];

export interface EventView {
  version: number;
  kind: "events";
  name: string;
  description?: string | null;
  query: Omit<EventsQuery, "signal">;
}

export interface LogViewQuery {
  level?: string | null;
  min_level?: string | null;
  service?: string | null;
  environment?: string | null;
  source_id?: string | null;
  search?: string | null;
  filters?: LogFilter[];
}

export interface LogView {
  version: number;
  kind: "logs";
  name: string;
  description?: string | null;
  query: LogViewQuery;
  window?: "15m" | "1h" | "6h" | "24h" | "7d" | null;
}

export type ViewDocument = EventView | LogView;

// The view documents, from the dashboard schema's own query definitions.
const defs = schema.$defs as Record<string, Record<string, unknown>>;
const querySpec = schema.$defs.QuerySpec as { oneOf: { properties: Record<string, unknown> }[] };
const branch = (signal: string) =>
  querySpec.oneOf.find((b) => (b.properties.signal as { const: string }).const === signal) as {
    properties: Record<string, unknown>;
  };
const { signal: _events, ...eventFields } = branch("events").properties;
const {
  signal: _logs,
  measure: _measure,
  attribute: _attribute,
  group_by: _groupBy,
  ...logFields
} = branch("logs").properties;
const common = {
  version: { format: "uint32", minimum: 0, type: "integer" },
  name: { type: "string" },
  description: { type: ["string", "null"] },
};
const viewSchema = {
  $defs: {
    ...defs,
    EventView: {
      additionalProperties: false,
      properties: {
        ...common,
        kind: { enum: ["events"], type: "string", default: "events" },
        query: { $ref: "#/$defs/EventViewQuery" },
      },
      required: ["version", "name", "query"],
      type: "object",
    },
    EventViewQuery: { additionalProperties: false, properties: eventFields, type: "object" },
    LogView: {
      additionalProperties: false,
      properties: {
        ...common,
        kind: { enum: ["logs"], type: "string" },
        query: { $ref: "#/$defs/LogViewQuery" },
        window: {
          anyOf: [{ enum: ["15m", "1h", "6h", "24h", "7d"], type: "string" }, { type: "null" }],
        },
      },
      required: ["version", "kind", "name", "query"],
      type: "object",
    },
    LogViewQuery: { additionalProperties: false, properties: logFields, type: "object" },
  },
};
const parser = new SchemaParser(viewSchema);

function failed(path: string, message: string): Parsed<never> {
  const report = new Report();
  report.error(path, message);
  return { ok: false, report };
}

/** Parses a document, reporting the JSON Pointer of the first fault. No `kind` is an event view. */
export function parseView(value: unknown): Parsed<ViewDocument> {
  const kind =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).kind
      : undefined;
  if (kind !== undefined && !KINDS.includes(kind as ViewKind))
    return failed("/kind", "kind must be events or logs");
  try {
    const definition = { $ref: kind === "logs" ? "#/$defs/LogView" : "#/$defs/EventView" };
    return { ok: true, value: parser.parse(definition, value) as ViewDocument };
  } catch (error) {
    if (!(error instanceof ShapeError)) throw error;
    return failed(error.path, error.message);
  }
}

/** Every rule a document must satisfy before it is stored. */
export function checkView(doc: ViewDocument): Report {
  const r = new Report();
  if (doc.version !== 1) r.error("/version", "version must be 1");
  textLength(r, "/name", doc.name, 1, Limits.MAX_NAME_CHARS, "name");
  if (doc.description != null && [...doc.description].length > Limits.MAX_DESCRIPTION_CHARS)
    r.error(
      "/description",
      `description must be at most ${Limits.MAX_DESCRIPTION_CHARS} characters`,
    );
  if (doc.kind === "events") {
    checkEvents({ ...doc.query, signal: "events" } as EventsQuery, "/query", r);
    if (!MEASURES.includes(doc.query.measure))
      r.error(
        "/query/measure",
        "The Events page cannot show this measure",
        `Use ${MEASURES.slice(0, -1).join(", ")} or ${MEASURES.at(-1)}, or show it in a dashboard`,
      );
    for (const [i, f] of (doc.query.filters ?? []).entries())
      if (!EVENTS_PAGE_OPS.includes(f.op))
        r.error(
          `/query/filters/${i}/op`,
          `The Events page cannot filter with \`${f.op}\``,
          "Use eq, ne, gt, gte, lt or lte, or show it in a dashboard",
        );
  } else {
    checkLogs(
      { ...doc.query, signal: "logs", measure: "count", attribute: null, group_by: null },
      "/query",
      r,
    );
    for (const [i, f] of (doc.query.filters ?? []).entries())
      if ((f.op ?? "eq") !== "eq")
        r.error(
          `/query/filters/${i}/op`,
          "The Logs page filters attributes by equality only",
          "Remove op, or show it in a dashboard",
        );
  }
  return r;
}

export interface StoredView {
  id: string;
  slug: string;
  kind: ViewKind;
  created_at: string;
  updated_at: string;
  document: ViewDocument;
}

function validated(doc: ViewDocument): string {
  const report = checkView(doc);
  if (!report.ok) throw invalid(report, "view");
  return serialize(doc);
}

/** A stored document; one written without `kind` is an event view. */
function fromStored(text: string): ViewDocument {
  const parsed = parseView(JSON.parse(text));
  if (!parsed.ok) {
    const first = parsed.report.errors[0];
    throw new ApiError(500, `Stored view is invalid: ${first?.path}: ${first?.message}`);
  }
  return parsed.value;
}

function load(store: Store, id: string): StoredView {
  const row = store.db
    .query("SELECT id, slug, kind, created_at, updated_at, document FROM views WHERE id = ?")
    .get(id) as Omit<StoredView, "document"> & { document: string };
  return { ...row, document: fromStored(row.document) };
}

export function listViews(store: Store, product: string, kind: ViewKind | null) {
  requireProductSync(store, product);
  const rows = store.db
    .query(
      "SELECT id, slug, name, kind, updated_at, document FROM views WHERE product_id = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY name COLLATE NOCASE, name, id",
    )
    .all(product, kind) as {
    id: string;
    slug: string;
    name: string;
    kind: ViewKind;
    updated_at: string;
    document: string;
  }[];
  return rows.map(({ document, ...row }) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    description: (JSON.parse(document) as { description?: string }).description ?? null,
    updated_at: row.updated_at,
  }));
}

/** The not-found error for a view that exists under no kind, with the nearest slugs. */
function unknown(store: Store, product: string, key: string, kind: ViewKind | null) {
  const slugs = listViews(store, product, kind).map((v) => v.slug);
  return notFound("View", missingHint(key, slugs, "views"));
}

const ambiguous = (key: string, hint: string) =>
  detailed(409, "More than one view has that slug", "ambiguous_view", [
    { path: "/view", message: `\`${key}\` is both an events view and a logs view`, hint },
  ]);

/**
 * A project's view by id or slug. An id is always exact. A slug shared by both kinds needs
 * `kind`; without it the lookup is ambiguous and says so.
 */
function resolve(
  store: Store,
  product: string,
  key: string,
  kind: ViewKind | null,
  hint = "Pass ?kind=events or ?kind=logs (the `kind` argument over MCP)",
): { id: string; kind: ViewKind } {
  const exact = store.db
    .query("SELECT id, kind FROM views WHERE product_id = ?1 AND id = ?2")
    .get(product, key) as { id: string; kind: ViewKind } | null;
  if (exact) return exact;
  const shared = store.db
    .query("SELECT id, kind FROM views WHERE product_id = ?1 AND slug = ?2 ORDER BY kind")
    .all(product, key) as { id: string; kind: ViewKind }[];
  if (kind) {
    const found = shared.find((v) => v.kind === kind);
    if (found) return found;
    const other = shared[0];
    if (other)
      throw notFound(
        "View",
        `\`${key}\` exists as a ${other.kind} view; use kind \`${other.kind}\``,
      );
    throw unknown(store, product, key, kind);
  }
  if (shared.length === 1) return shared[0] as { id: string; kind: ViewKind };
  if (shared.length === 0) throw unknown(store, product, key, null);
  throw ambiguous(key, hint);
}

export function getView(store: Store, product: string, key: string, kind: ViewKind | null) {
  requireProductSync(store, product);
  return load(store, resolve(store, product, key, kind).id);
}

/** A slug for a view name, by the project rule. Only a name that rule empties becomes `view`. */
function viewSlug(name: string): string {
  return /[A-Za-z0-9]/.test(name) ? projectSlug(name) : "view";
}

function immediate<T>(store: Store, work: () => T): T {
  return store.db.transaction(work).immediate();
}

export function createView(store: Store, product: string, doc: ViewDocument): StoredView {
  const text = validated(doc);
  requireProductSync(store, product);
  return immediate(store, () => {
    const { n } = store.db
      .query("SELECT count(*) AS n FROM views WHERE product_id = ?")
      .get(product) as { n: number };
    if (n >= MAX_VIEWS_PER_PROJECT)
      throw limit(`A project holds at most ${MAX_VIEWS_PER_PROJECT} views`);
    const id = newId();
    const at = now();
    const base = viewSlug(doc.name);
    let slug = base;
    for (let suffix = 2; ; suffix++) {
      // The unique index arbitrates the slug per kind; a reserved slug counts as taken.
      const inserted = RESERVED_SLUGS.includes(slug)
        ? 0
        : store.db
            .query(
              "INSERT INTO views(id, product_id, kind, slug, name, document, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT(product_id, kind, slug) DO NOTHING",
            )
            .run(id, product, doc.kind, slug, doc.name, text, at).changes;
      if (inserted === 1) break;
      slug = `${base}-${suffix}`;
    }
    return load(store, id);
  });
}

/**
 * Replaces the whole document of a view, which keeps its kind and slug. `kindWritten` says
 * whether the document named its kind: a slug shared by both kinds is unambiguous only then.
 */
export function replaceView(
  store: Store,
  product: string,
  key: string,
  doc: ViewDocument,
  kindWritten: boolean,
): StoredView {
  const text = validated(doc);
  requireProductSync(store, product);
  return immediate(store, () => {
    const found = resolve(
      store,
      product,
      key,
      kindWritten ? doc.kind : null,
      'Write "kind": "events" or "kind": "logs" in the document',
    );
    if (found.kind !== doc.kind) {
      if (found.id === key) {
        const r = new Report();
        r.error("/kind", `This is a ${found.kind} view; its kind cannot change`);
        throw invalid(r, "view");
      }
      throw notFound(
        "View",
        `\`${key}\` exists as a ${found.kind} view; write \`"kind": "${found.kind}"\` in the document`,
      );
    }
    store.db
      .query("UPDATE views SET name = ?1, document = ?2, updated_at = ?3 WHERE id = ?4")
      .run(doc.name, text, now(), found.id);
    return load(store, found.id);
  });
}

export function deleteView(store: Store, product: string, key: string, kind: ViewKind | null) {
  requireProductSync(store, product);
  immediate(store, () => {
    const { id } = resolve(store, product, key, kind);
    store.db.query("DELETE FROM views WHERE id = ?").run(id);
  });
}

/** The `?kind=` of a request, if any. */
export function kindParam(value: string | null | undefined): ViewKind | null {
  if (value == null) return null;
  if (KINDS.includes(value as ViewKind)) return value as ViewKind;
  throw detailed(400, "kind must be events or logs", "invalid_kind", [
    { path: "/kind", message: `\`${value}\` is not a view kind`, hint: "Use `events` or `logs`" },
  ]);
}

function document(value: unknown): ViewDocument {
  const parsed = parseView(value);
  if (!parsed.ok) throw invalid(parsed.report, "view");
  return parsed.value;
}

/** Creates a view in project `product` (an id). */
export function createFor(ctx: ApiContext, product: string, value: unknown): StoredView {
  throttle(ctx, product);
  const stored = createView(ctx.store, product, document(value));
  ctx.changes.notify(product, "dashboards");
  return stored;
}

/** Replaces the view `key` of project `product` (an id) with `value`. */
export function replaceFor(ctx: ApiContext, product: string, key: string, value: unknown) {
  throttle(ctx, product);
  const kindWritten =
    typeof value === "object" && value !== null && "kind" in (value as Record<string, unknown>);
  const stored = replaceView(ctx.store, product, key, document(value), kindWritten);
  ctx.changes.notify(product, "dashboards");
  return stored;
}

/** Deletes the view `key` of project `product` (an id). */
export function deleteFor(ctx: ApiContext, product: string, key: string, kind: ViewKind | null) {
  throttle(ctx, product);
  deleteView(ctx.store, product, key, kind);
  ctx.changes.notify(product, "dashboards");
}

const kindOf = (request: Request) => kindParam(new URL(request.url).searchParams.get("kind"));

export function registerViews(): void {
  const read = "/api/read/products/:project/views";
  route("GET", read, async (request, ctx, { project }) => {
    const kind = kindOf(request);
    return json(listViews(ctx.store, (await resolveProduct(ctx.db, project as string)).id, kind));
  });
  route("GET", `${read}/:key`, async (request, ctx, { project, key }) => {
    const kind = kindOf(request);
    const product = (await resolveProduct(ctx.db, project as string)).id;
    return json(getView(ctx.store, product, key as string, kind));
  });
  const write = "/api/products/:id/views";
  route("POST", write, async (request, ctx, { id }) => {
    const { document: value } = fields(await readJson(request), { document: "unknown" });
    return json(createFor(ctx, id as string, value));
  });
  route("PUT", `${write}/:key`, async (request, ctx, { id, key }) => {
    const { document: value } = fields(await readJson(request), { document: "unknown" });
    return json(replaceFor(ctx, id as string, key as string, value));
  });
  route("DELETE", `${write}/:key`, async (request, ctx, { id, key }) => {
    const kind = kindOf(request);
    deleteFor(ctx, id as string, key as string, kind);
    return noContent();
  });
}
