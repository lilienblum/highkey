import { validKey, validDate, validViewAt, validViewSlug } from "./workspace-search";
export type ExploreDrilldown = {
  productId?: string;
  from: string;
  to: string;
  event?: string;
  source?: string;
  sourceId?: string;
  filter?: { property: string; value: string | number | boolean };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ExploreSearch = {
  drilldown?: ExploreDrilldown;
  invalidDrilldown?: true;
  query?: ExploreSpec;
  /** The saved view this query came from; it marks the active item in the sidebar. */
  view?: string;
  /** The `updated_at` of the view version applied to the page; without it the view is applied. */
  viewAt?: string;
  page?: number;
  pageSize?: number;
  invalidQuery?: true;
};
function validateDrilldown(search: Record<string, unknown>): ExploreSearch {
  if (search.drilldown === undefined) {
    return {
      drilldown: undefined,
      invalidDrilldown: search.invalidDrilldown === true ? true : undefined,
    };
  }
  const value = search.drilldown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { drilldown: undefined, invalidDrilldown: true };
  }
  const d = value as Record<string, unknown>;
  if (
    (d.productId !== undefined &&
      (typeof d.productId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.productId))) ||
    !validDate(d.from) ||
    !validDate(d.to) ||
    Date.parse(d.to) <= Date.parse(d.from) ||
    Date.parse(d.to) - Date.parse(d.from) > 366 * 86400000 ||
    (d.event !== undefined && !validKey(d.event)) ||
    (d.source !== undefined && !validKey(d.source)) ||
    (d.sourceId !== undefined &&
      (typeof d.sourceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.sourceId)))
  )
    return { drilldown: undefined, invalidDrilldown: true };
  let filter: ExploreDrilldown["filter"];
  if (d.filter !== undefined) {
    if (!d.filter || typeof d.filter !== "object" || Array.isArray(d.filter)) {
      return { drilldown: undefined, invalidDrilldown: true };
    }
    const f = d.filter as Record<string, unknown>;
    if (
      !validKey(f.property) ||
      !(
        typeof f.value === "boolean" ||
        (typeof f.value === "number" && Number.isFinite(f.value)) ||
        (typeof f.value === "string" && new TextEncoder().encode(f.value).length <= 2048)
      )
    )
      return { drilldown: undefined, invalidDrilldown: true };
    filter = { property: f.property, value: f.value as string | number | boolean };
  }
  return {
    invalidDrilldown: undefined,
    drilldown: {
      productId: d.productId as string | undefined,
      from: d.from,
      to: d.to,
      ...(d.event !== undefined ? { event: d.event as string } : {}),
      ...(d.source !== undefined ? { source: d.source as string } : {}),
      ...(d.sourceId !== undefined ? { sourceId: d.sourceId as string } : {}),
      ...(filter ? { filter } : {}),
    },
  };
}

/** A filter beyond the one the query builder edits; the page shows it as a removable chip. */
export type ExploreFilter = { property: string; op: string; value: string | number | boolean };
export type ExploreSpec = {
  event: string;
  source: string;
  measure: string;
  property: string;
  group: string;
  filterProperty: string;
  filterOp: string;
  filterValue: string;
  /** Narrowing a saved view carries beyond the builder's controls; absent for ad-hoc queries. */
  identityKind?: string;
  sourceId?: string;
  moreFilters?: ExploreFilter[];
};
/** The spec fields the query builder edits as text. */
export type SpecTextKey = Exclude<keyof ExploreSpec, "identityKind" | "sourceId" | "moreFilters">;
export const defaultSpec: ExploreSpec = {
  event: "",
  source: "",
  measure: "count",
  property: "duration_ms",
  group: "name",
  filterProperty: "",
  filterOp: "eq",
  filterValue: "",
};
export function validateExploreSearch(search: Record<string, unknown>): ExploreSearch {
  const result = validateDrilldown(search);
  if (
    search.invalidQuery === true ||
    (search.page !== undefined &&
      (!Number.isInteger(search.page) || Number(search.page) < 1 || Number(search.page) > 10001)) ||
    (search.pageSize !== undefined && ![15, 30, 50].includes(Number(search.pageSize)))
  )
    return { ...result, invalidQuery: true };
  if (
    (search.view !== undefined && !validViewSlug(search.view)) ||
    (search.viewAt !== undefined && !validViewAt(search.viewAt))
  )
    return { ...result, invalidQuery: true };
  result.view = search.view as string | undefined;
  result.viewAt = search.viewAt as string | undefined;
  result.page = search.page as number | undefined;
  result.pageSize = search.pageSize === undefined ? undefined : Number(search.pageSize);
  if (search.query === undefined) return result;
  if (!search.query || typeof search.query !== "object" || Array.isArray(search.query))
    return { ...result, invalidQuery: true };
  const raw = search.query as Record<string, unknown>;
  const spec = { ...defaultSpec };
  for (const key of Object.keys(defaultSpec) as SpecTextKey[]) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string") return { ...result, invalidQuery: true };
      spec[key] = raw[key] as string;
    }
  }
  if (
    (spec.event && !validKey(spec.event)) ||
    (spec.source && !validKey(spec.source)) ||
    !["count", "actors", "sum", "avg", "p50", "p95", "min", "max"].includes(spec.measure) ||
    !validKey(spec.property) ||
    !(
      ["name", "source", "source_id", "identity_kind"].includes(spec.group) ||
      (spec.group.startsWith("property:") && validKey(spec.group.slice(9)))
    ) ||
    (spec.filterProperty && !validKey(spec.filterProperty)) ||
    !["eq", "ne", "gt", "gte", "lt", "lte"].includes(spec.filterOp) ||
    new TextEncoder().encode(spec.filterValue).length > 2048
  )
    return { ...result, invalidQuery: true };
  if (raw.identityKind !== undefined) {
    if (typeof raw.identityKind !== "string" || !raw.identityKind || raw.identityKind.length > 256)
      return { ...result, invalidQuery: true };
    spec.identityKind = raw.identityKind;
  }
  if (raw.sourceId !== undefined) {
    if (typeof raw.sourceId !== "string" || !uuid.test(raw.sourceId))
      return { ...result, invalidQuery: true };
    spec.sourceId = raw.sourceId;
  }
  if (raw.moreFilters !== undefined) {
    if (!Array.isArray(raw.moreFilters) || raw.moreFilters.length > 7)
      return { ...result, invalidQuery: true };
    const more: ExploreFilter[] = [];
    for (const item of raw.moreFilters) {
      const f = item as Record<string, unknown> | null;
      if (
        !f ||
        typeof f !== "object" ||
        !validKey(f.property) ||
        typeof f.op !== "string" ||
        !["eq", "ne", "gt", "gte", "lt", "lte"].includes(f.op) ||
        !(
          typeof f.value === "boolean" ||
          (typeof f.value === "number" && Number.isFinite(f.value)) ||
          (typeof f.value === "string" && new TextEncoder().encode(f.value).length <= 2048)
        ) ||
        // The API orders only numbers.
        (typeof f.value !== "number" && !["eq", "ne"].includes(f.op))
      )
        return { ...result, invalidQuery: true };
      more.push({ property: f.property, op: f.op, value: f.value });
    }
    if (more.length) spec.moreFilters = more;
  }
  result.query = spec;
  return result;
}

/**
 * The query the page runs: the URL's, or the defaults narrowed by a drilldown from Overview, a
 * breakdown or a dashboard widget.
 */
export function appliedSpec(search: Pick<ExploreSearch, "query" | "drilldown">): ExploreSpec {
  const { query, drilldown } = search;
  return (
    query ?? {
      ...defaultSpec,
      event: drilldown?.event ?? "",
      source: drilldown?.source ?? "",
      filterProperty: drilldown?.filter?.property ?? "",
      filterValue: drilldown?.filter ? JSON.stringify(drilldown.filter.value) : "",
    }
  );
}
