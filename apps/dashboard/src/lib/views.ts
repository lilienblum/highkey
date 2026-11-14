import { api, ApiError, type ViewLink } from "./api";
import { defaultSpec, type ExploreSpec } from "./explore-search";
import { asDocumentError, type EventMeasure, type Issue } from "./dashboards";

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

/** The API's first complaint about a view document, else the error itself. */
export function viewErrorMessage(error: unknown, fallback: string): string {
  const issues = (error as { issues?: Issue[] }).issues;
  if (Array.isArray(issues) && issues[0]) return issues[0].message;
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

const numericMeasures = ["sum", "avg", "p50", "p95"];
const comparisons = ["eq", "ne", "gt", "gte", "lt", "lte"];

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
 * The events query a view stores for what the Events page runs. The date range and workspace
 * source come from the toolbar, and the client name has no place in the query, so neither is saved.
 */
export function specToQuery(spec: ExploreSpec): EventViewQuery {
  const query: EventViewQuery = { measure: spec.measure as EventMeasure };
  if (spec.event) query.event = spec.event;
  if (numericMeasures.includes(spec.measure)) query.property = spec.property;
  if (spec.filterProperty && spec.filterValue)
    query.filters = [
      {
        property: spec.filterProperty,
        op: spec.filterOp,
        value: typedValue(spec.filterValue),
      },
    ];
  query.group_by = spec.group;
  return query;
}

/**
 * What the Events page runs for a stored view. It shows one filter, no identity kind and the
 * workspace's source, so a query that uses more is opened with what the page can show.
 */
export function queryToSpec(query: EventViewQuery): ExploreSpec {
  const filter = query.filters?.find((candidate) => comparisons.includes(candidate.op));
  return {
    ...defaultSpec,
    event: query.event ?? "",
    measure: query.measure ?? "count",
    property: query.property ?? defaultSpec.property,
    group: query.group_by ?? defaultSpec.group,
    ...(filter
      ? {
          filterProperty: filter.property,
          filterOp: filter.op,
          filterValue: valueText(filter.value),
        }
      : {}),
  };
}
