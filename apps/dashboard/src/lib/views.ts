import { api, type ViewLink } from "./api";
import { defaultSpec, validateExploreSearch, type ExploreSpec } from "./explore-search";
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
/** Documents of the other kind are carried untouched; the Events page only reads its own. */
export type ViewDocument = EventViewDocument | { version: 1; kind: "logs"; name: string };
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
/** The text that types a value back into the query builder. */
function valueText(value: Scalar): string {
  return typeof value === "string" && typedValue(value) === value ? value : JSON.stringify(value);
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
