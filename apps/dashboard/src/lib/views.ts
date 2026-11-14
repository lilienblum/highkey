import { api, type ViewLink } from "./api";
import { defaultSpec, validateExploreSearch, type ExploreSpec } from "./explore-search";
import {
  attributeValue,
  type logWindows,
  validateLogsSearch,
  type LogAttributeFilter,
  type LogLevel,
  type LogsSearch,
} from "./logs";
import { asDocumentError, DocumentError, type EventMeasure, type Issue } from "./dashboards";

export type { ViewLink };
export { validViewSlug } from "./workspace-search";
export type ViewKind = ViewLink["kind"];

type Scalar = string | number | boolean;
/** The events query of a view: the dashboards events query without its `signal`. */
export type EventViewQuery = {
  event?: string;
  source_id?: string;
  identity_kind?: string;
  measure: EventMeasure;
  property?: string;
  filters?: { property: string; op: string; value: Scalar }[];
  group_by?: string;
};
export type EventViewDocument = {
  version: 1;
  kind: "events";
  name: string;
  description?: string;
  query: EventViewQuery;
};
/** The logs query of a view: the dashboards logs query's filter fields only. */
export type LogViewQuery = {
  level?: string;
  min_level?: string;
  service?: string;
  environment?: string;
  source_id?: string;
  search?: string;
  filters?: { attribute: string; value: Scalar }[];
};
export type LogViewWindow = keyof typeof logWindows;
export type LogViewDocument = {
  version: 1;
  kind: "logs";
  name: string;
  description?: string;
  query: LogViewQuery;
  window?: LogViewWindow;
};
export type ViewDocument = EventViewDocument | LogViewDocument;
export type StoredView<D extends ViewDocument = ViewDocument> = {
  id: string;
  slug: string;
  kind: D["kind"];
  created_at: string;
  updated_at: string;
  document: D;
};

const read = (project: string) => `/read/products/${encodeURIComponent(project)}/views`;
const write = (productId: string) => `/products/${encodeURIComponent(productId)}/views`;
const part = encodeURIComponent;

export const getView = <D extends ViewDocument>(
  project: string,
  key: string,
  kind: D["kind"],
  signal?: AbortSignal,
) =>
  asRejected(
    api<StoredView<D>>(`${read(project)}/${part(key)}?kind=${kind}`, "GET", undefined, signal),
  );
export const createView = <D extends ViewDocument>(productId: string, document: D) =>
  asRejected(api<StoredView<D>>(write(productId), "POST", { document }));
/** Replaces the whole document; the view keeps its slug. */
export const saveView = <D extends ViewDocument>(productId: string, key: string, document: D) =>
  asRejected(api<StoredView<D>>(`${write(productId)}/${part(key)}`, "PUT", { document }));
export const deleteView = (productId: string, key: string, kind: ViewKind) =>
  asRejected(api<void>(`${write(productId)}/${part(key)}?kind=${kind}`, "DELETE"));

async function asRejected<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw asDocumentError(error);
  }
}

/**
 * The API's first complaint about a view write: its message and, when it has one, its hint
 * ("Retry after 12 s" on a rate limit), else the error itself.
 */
export function viewErrorMessage(error: unknown, fallback: string): string {
  const issues =
    error instanceof DocumentError
      ? error.issues
      : (error as { payload?: { errors?: unknown } } | null)?.payload?.errors;
  const first = Array.isArray(issues) ? (issues[0] as Issue | undefined) : undefined;
  if (first?.message)
    return first.hint ? `${first.message.replace(/\.$/, "")}. ${first.hint}` : first.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

const numericMeasures = ["sum", "avg", "p50", "p95", "min", "max"];

/** A filter value as the query builder reads it: JSON when it parses as a scalar, else text. */
function typedValue(text: string): Scalar {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      return value;
  } catch {}
  return text;
}
/** The text that types a value back into the query builder; an empty string stays quoted. */
function valueText(value: Scalar): string {
  return typeof value === "string" && value !== "" && typedValue(value) === value
    ? value
    : JSON.stringify(value);
}

/**
 * The events query a view stores for what the Events page runs. The date range and the workspace
 * source come from the toolbar, so neither is saved; a source the view pins is its own. The
 * client name has no place in the query and is not saved. Grouping by event name is the API's
 * default, so it is left out.
 */
export function specToQuery(spec: ExploreSpec): EventViewQuery {
  const query: EventViewQuery = { measure: spec.measure as EventMeasure };
  if (spec.event) query.event = spec.event;
  if (spec.sourceId) query.source_id = spec.sourceId;
  if (spec.identityKind) query.identity_kind = spec.identityKind;
  if (numericMeasures.includes(spec.measure)) query.property = spec.property;
  const filters: NonNullable<EventViewQuery["filters"]> = [];
  if (spec.filterProperty && spec.filterValue)
    filters.push({
      property: spec.filterProperty,
      op: spec.filterOp,
      value: typedValue(spec.filterValue),
    });
  filters.push(...(spec.moreFilters ?? []));
  if (filters.length) query.filters = filters;
  if (spec.group !== defaultSpec.group) query.group_by = spec.group;
  return query;
}

/**
 * What the Events page runs for a stored view: the first filter fills the builder's filter row, the
 * rest become chips, and a pinned identity kind or source becomes a chip. Nothing is dropped.
 */
export function queryToSpec(query: EventViewQuery): ExploreSpec {
  const [first, ...rest] = query.filters ?? [];
  return {
    ...defaultSpec,
    event: query.event ?? "",
    measure: query.measure ?? "count",
    property: query.property ?? defaultSpec.property,
    group: query.group_by ?? defaultSpec.group,
    ...(first
      ? { filterProperty: first.property, filterOp: first.op, filterValue: valueText(first.value) }
      : {}),
    ...(query.identity_kind ? { identityKind: query.identity_kind } : {}),
    ...(query.source_id ? { sourceId: query.source_id } : {}),
    ...(rest.length ? { moreFilters: rest } : {}),
  };
}

/** Whether the Events page can run a spec, by the same rules as its URL. */
export function explorable(spec: ExploreSpec): boolean {
  return !validateExploreSearch({ query: spec }).invalidQuery;
}

const defaultLogWindow: LogViewWindow = "1h";

/**
 * The logs query a view stores for what the Logs page runs. The time window is saved beside it,
 * and the workspace source is not, but a source a view pins is its own. A trace ID, a selected
 * range and an older-logs cursor have no place in a view.
 */
export function logsToQuery(search: LogsSearch): LogViewQuery {
  const query: LogViewQuery = {};
  if (search.level) query.level = search.level;
  if (search.minLevel) query.min_level = search.minLevel;
  if (search.service) query.service = search.service;
  if (search.environment) query.environment = search.environment;
  if (search.logSource) query.source_id = search.logSource;
  if (search.logq) query.search = search.logq;
  const filters: NonNullable<LogViewQuery["filters"]> = [];
  if (search.attribute)
    filters.push({
      attribute: search.attribute,
      value: attributeValue(search.attributeValue ?? "", search.attributeType ?? "string"),
    });
  filters.push(...(search.moreFilters ?? []));
  if (filters.length) query.filters = filters;
  return query;
}

/**
 * What the Logs page runs for a stored view: the first attribute filter fills the filter panel's
 * row and the rest become chips. The window is always set, so a view that names none opens on the
 * page's default one; that also tells the page the view has been applied.
 */
export function queryToLogs(query: LogViewQuery, window?: LogViewWindow): LogsSearch {
  const [first, ...rest] = query.filters ?? [];
  return {
    logWindow: window ?? defaultLogWindow,
    ...(query.search ? { logq: query.search } : {}),
    ...(query.level ? { level: query.level as LogLevel } : {}),
    ...(query.min_level ? { minLevel: query.min_level as LogLevel } : {}),
    ...(query.service ? { service: query.service } : {}),
    ...(query.environment ? { environment: query.environment } : {}),
    ...(query.source_id ? { logSource: query.source_id } : {}),
    ...(first
      ? {
          attribute: first.attribute,
          attributeValue: String(first.value),
          attributeType: typeof first.value as "string" | "number" | "boolean",
        }
      : {}),
    ...(rest.length ? { moreFilters: rest as LogAttributeFilter[] } : {}),
  };
}

/** Whether the Logs page can run a search, by the same rules as its URL. */
export function logsRunnable(search: LogsSearch): boolean {
  return !validateLogsSearch({ ...search }).invalidLogs;
}

/**
 * The stored log view with the page's current filters and window in place of its own. A window
 * the page only holds as the default is not written into a view that named none.
 */
export function currentLogView(stored: LogViewDocument, search: LogsSearch): LogViewDocument {
  const { window: _window, ...rest } = stored;
  const window = search.logWindow;
  const unchanged = stored.window === undefined && window === defaultLogWindow;
  return {
    ...rest,
    query: logsToQuery(search),
    ...(window && !unchanged ? { window } : {}),
  };
}

/** Every cached stored view; an open view's is the active query. */
export const viewQueries = ["view"] as const;

/** JSON with sorted keys, so equal values compare equal after a URL round trip. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** What the Events page shows of a view: the query it would save, comparable as text. */
export function eventViewState(spec: ExploreSpec): string {
  return canonical(specToQuery(spec));
}

/** What the Logs page shows of a view: its filters and time window, comparable as text. */
export function logViewState(search: LogsSearch): string {
  try {
    return canonical({ query: logsToQuery(search), window: search.logWindow ?? defaultLogWindow });
  } catch {
    // An attribute value of the wrong type cannot be a view's.
    return "";
  }
}

/**
 * How an open view stands against the stored one. `current`: the page applied this version.
 * `bump`: a newer version whose query the page already shows or started from (a rename, say), so
 * only the applied marker moves. `apply`: a newer query and nothing changed on the page, so it
 * applies in place. `changed`: a newer query while the page has changes of its own (or the page
 * cannot tell), so the reader chooses.
 */
export type ViewSync = "current" | "bump" | "apply" | "changed";
export function viewSync(options: {
  /** The `updated_at` the page applied. */
  appliedAt?: string;
  /** The state the page showed when it applied that version, when this page load knows it. */
  applied?: string;
  /** The state the page shows now. */
  page: string;
  stored: { at: string; state: string };
}): ViewSync {
  const { appliedAt, applied, page, stored } = options;
  if (appliedAt !== undefined && stored.at === appliedAt) return "current";
  if (stored.state === page) return "bump";
  if (applied !== undefined && appliedAt !== undefined) {
    if (stored.state === applied) return "bump";
    if (page === applied) return "apply";
  }
  return "changed";
}

/** Each view's last applied version and what the page showed then, for this page load. */
const applied = new Map<string, { at: string; state: string }>();
export const viewIdentity = (productId: string, kind: ViewKind, slug: string) =>
  `${productId}:${kind}:${slug}`;
/** Remembers what a page showed when it applied a view version (in the browser only). */
export function rememberApplied(view: string, at: string, state: string) {
  applied.set(view, { at, state });
}
/** What the page showed when it applied version `at`, if this page load applied it. */
export function appliedState(view: string, at: string | undefined): string | undefined {
  const entry = applied.get(view);
  return entry && entry.at === at ? entry.state : undefined;
}
