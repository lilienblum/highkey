import { api, ApiError, number, queryReadOnly, type DashboardLink } from "./api";

export type { DashboardLink };

export type Color = "yellow" | "violet" | "aqua" | "green" | "red" | "neutral";
export type Unit = "number" | "percent" | "ratio" | "ms" | "seconds" | "bytes";
export type ViewKind =
  | "stat"
  | "line"
  | "area"
  | "bar"
  | "ranking"
  | "table"
  | "events"
  | "logs"
  | "text";
export type Size = { w: 3 | 4 | 6 | 8 | 12; h: 1 | 2 | 3 };
export type Threshold = { at: number; color: Color };

export type Series = {
  expr: string;
  label?: string;
  color?: Color;
  unit?: Unit;
  thresholds?: Threshold[];
};
export type View = {
  type: ViewKind;
  unit?: Unit;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  sparkline?: boolean;
  /** Absent means the previous period for stat, line, area and bar views. */
  compare?: "previous_period" | "none";
  /** Which direction of change is good. Absent means down for ms and seconds, otherwise up. */
  better?: "up" | "down";
  bucket?: string;
  stacked?: boolean;
  limit?: number;
  markdown?: string;
};
/** Mirrors the API: stat and chart views compare with the previous period unless they opt out. */
export function comparesPreviousPeriod(view: Pick<View, "type" | "compare">) {
  if (view.compare) return view.compare === "previous_period";
  return (
    view.type === "stat" || view.type === "line" || view.type === "area" || view.type === "bar"
  );
}
/** Whether a fall is the good outcome; `unit` is the series' own unit when it has one. */
export function lowerIsBetter(view: Pick<View, "unit" | "better">) {
  return view.better ? view.better === "down" : view.unit === "ms" || view.unit === "seconds";
}
export type EventMeasure = "count" | "actors" | "sum" | "avg" | "p50" | "p95" | "min" | "max";
export type LogMeasure = "count" | "sum" | "avg" | "p50" | "p95" | "min" | "max";
export type EventsQuery = {
  signal: "events";
  event?: string;
  source_id?: string;
  identity_kind?: string;
  measure?: EventMeasure;
  property?: string;
  filters?: { property: string; op: string; value: string | number | boolean }[];
  group_by?: string;
};
export type LogsQuery = {
  signal: "logs";
  level?: string;
  min_level?: string;
  service?: string;
  environment?: string;
  source_id?: string;
  search?: string;
  filters?: { attribute: string; value: string | number | boolean | null }[];
  measure?: LogMeasure;
  attribute?: string;
  group_by?: string;
};
export type SqlQuery = {
  signal: "sql";
  database: "events" | "logs";
  sql: string;
  missing?: "zero" | "null";
};
export type QuerySpec = EventsQuery | LogsQuery | SqlQuery;
export type Widget = {
  id: string;
  title: string;
  description?: string;
  view: View;
  size?: Size;
  range?: string;
  timeout_ms?: number;
  queries: Record<string, QuerySpec>;
  series?: Series[];
};
export type DashboardDocument = {
  $schema?: string;
  version: 1;
  name: string;
  description?: string;
  widgets: Widget[];
};

/** A JSON Pointer into the document, as every validation issue carries it. */
export type Issue = { path: string; message: string; hint?: string | null };
export type StoredDashboard = {
  id: string;
  slug: string;
  revision: number;
  updated_at: string;
  document: DashboardDocument;
};
export type RevisionInfo = {
  revision: number;
  origin: "dashboard" | "mcp" | "api";
  created_at: string;
};
export type SeriesResult = {
  label: string;
  color: Color;
  group?: string | number | boolean | null;
  total: number | null;
  previous_total?: number | null;
  points?: { time: number; value: number | null }[];
  previous_points?: { time: number; value: number | null }[];
  groups?: { label: string | number | boolean | null; value: number | null }[];
};
export type ResultColumn = { name: string; type: string };
export type RunResult = {
  widget: string;
  range: {
    from: string;
    to: string;
    bucket: string;
    clamped: boolean;
    requested_from: string;
    requested_to: string;
  };
  series: SeriesResult[];
  /** Event or log rows for list views; arrays of cell values (one per column) for a table. */
  rows: Record<string, unknown>[] | unknown[][] | null;
  /** A table view's result columns, each `{ name, type }` (or `[name, type]`) with a DuckDB type. */
  columns?: (ResultColumn | [string, string])[] | null;
  elapsed_ms: number;
  warnings: Issue[];
};
export type RunRequest = {
  widget: Widget;
  from: string;
  to: string;
  bucket?: string;
  source_id?: string;
};
/** A 400 `invalid_document` or 409 `revision_conflict`; carries the issues and the current revision. */
export class DocumentError extends ApiError {
  constructor(
    message: string,
    status: number,
    public code: string,
    public issues: Issue[],
    public revision?: number,
  ) {
    super(message, status);
  }
}

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
  try {
    return await api<T>(path, method, body, signal);
  } catch (error) {
    throw asDocumentError(error);
  }
}
export function asDocumentError(error: unknown): unknown {
  if (!(error instanceof ApiError) || error instanceof DocumentError) return error;
  const code = error.payload?.code;
  if (code !== "invalid_document" && code !== "revision_conflict") return error;
  const issues = error.payload?.errors;
  const revision = error.payload?.revision;
  return new DocumentError(
    error.message,
    error.status,
    code,
    Array.isArray(issues) ? (issues as Issue[]) : [],
    typeof revision === "number" ? revision : undefined,
  );
}

const read = (project: string) => `/read/products/${encodeURIComponent(project)}`;
const write = (productId: string) => `/products/${encodeURIComponent(productId)}/dashboards`;
const part = encodeURIComponent;

export const listRevisions = (project: string, key: string, signal?: AbortSignal) =>
  request<RevisionInfo[]>(
    `${read(project)}/dashboards/${part(key)}/revisions`,
    "GET",
    undefined,
    signal,
  );
export const runWidget = (project: string, body: RunRequest, signal: AbortSignal) =>
  queryReadOnly<RunResult>(`${read(project)}/widgets/run`, body, signal);
export const createDashboard = (productId: string, document: DashboardDocument) =>
  request<StoredDashboard>(write(productId), "POST", { document });
export const restoreRevision = (productId: string, key: string, revision: number) =>
  request<StoredDashboard>(
    `${write(productId)}/${part(key)}/revisions/${revision}/restore`,
    "POST",
  );
export const deleteDashboard = (productId: string, key: string) =>
  request<void>(`${write(productId)}/${part(key)}`, "DELETE");

export function resolvedSize(widget: Widget): Size {
  if (widget.size) return widget.size;
  switch (widget.view.type) {
    case "stat":
      return { w: 3, h: 1 };
    case "events":
    case "logs":
      return { w: 12, h: 3 };
    case "text":
      return { w: 4, h: 1 };
    default:
      return { w: 6, h: 2 };
  }
}

/** Spec section 5: 3 and 4 become 6 and 8 becomes 12 when medium; everything is 12 when narrow. */
export function responsiveWidth(w: number, tier: "wide" | "medium" | "narrow"): number {
  if (tier === "narrow") return 12;
  if (tier === "medium") return w >= 8 ? 12 : w <= 4 ? 6 : w;
  return w;
}

const hues: Color[] = ["yellow", "violet", "aqua"];
/** Series 0-2 are solid yellow, violet, aqua; 3-5 repeat the hues at the 50% dither tone. */
export function seriesStyle(index: number): { color: Color; dither: boolean } {
  const i = Math.max(0, Math.floor(index));
  return { color: hues[i % 3], dither: i % 6 >= 3 };
}

/** The color of the last step reached (`value >= at`); the fallback below the first step. */
export function thresholdColor(
  value: number | null,
  thresholds: Threshold[],
  fallback: Color,
): Color {
  if (value === null || !Number.isFinite(value)) return fallback;
  let color = fallback;
  for (const step of [...thresholds].sort((a, b) => a.at - b.at)) {
    if (value >= step.at) color = step.color;
  }
  return color;
}

const measureNames = {
  sum: "Sum",
  avg: "Avg",
  p50: "p50",
  p95: "p95",
  min: "Min",
  max: "Max",
} as const;
/** What a query measures, in words: "Events", "Actors", "Avg duration_ms"; logs counts read "Logs". */
export function queryLabel(query: QuerySpec): string {
  if (query.signal === "sql") return "SQL";
  const measure = query.measure ?? "count";
  if (measure === "count") return query.signal === "logs" ? "Logs" : "Events";
  if (measure === "actors") return "Actors";
  const field = query.signal === "events" ? query.property : query.attribute;
  return field ? `${measureNames[measure]} ${field}` : measureNames[measure];
}

/**
 * The name the UI shows for a widget's series. An explicit label wins; otherwise a bare query id
 * reads as what it measures and a formula reads as its expression. The API's own labels (the
 * expression or query id) are left as they are; this is display only.
 */
export function seriesDisplayLabel(widget: Widget, index: number): string | undefined {
  const series = widget.series?.[index];
  if (series?.label) return series.label;
  // Without `series`, each query is one series, in order.
  const expr = widget.series ? series?.expr.trim() : Object.keys(widget.queries)[index];
  if (expr === undefined) return undefined;
  const query = Object.hasOwn(widget.queries, expr) ? widget.queries[expr] : undefined;
  // An SQL query has no measure to name, so it reads as its id.
  return query && query.signal !== "sql" ? queryLabel(query) : expr;
}

/** Whether a series was given its own label; the title already names a lone unlabelled stat. */
export const hasSeriesLabel = (widget: Widget, index: number) => !!widget.series?.[index]?.label;

export const TABLE_ROW_LIMIT = 500;
export const TABLE_COLUMN_LIMIT = 50;

/** A table view's columns as `{ name, type }`, at most 50, whichever shape the API sent. */
export function tableColumns(columns: RunResult["columns"]): ResultColumn[] {
  return (columns ?? [])
    .slice(0, TABLE_COLUMN_LIMIT)
    .map((column) =>
      Array.isArray(column) ? { name: String(column[0]), type: String(column[1]) } : column,
    );
}

export type CellKind = "number" | "timestamp" | "date" | "boolean" | "json" | "text";
/** How a DuckDB type is shown: times arrive as epoch milliseconds, structures as JSON. */
export function cellKind(type: string): CellKind {
  const t = type.trim().toUpperCase();
  if (t === "JSON" || t.endsWith("]") || /^(STRUCT|MAP|UNION)\b/.test(t)) return "json";
  if (t === "BOOLEAN") return "boolean";
  if (t === "DATE") return "date";
  if (/^TIMESTAMP/.test(t)) return "timestamp";
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|BIGNUM)\b/.test(t))
    return "number";
  return "text";
}

const cellNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const cellSmall = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const identifier = /(^|_)id$/i;

/** A time the Date object can hold, or null (DuckDB's range is wider than JavaScript's). */
export function validTime(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

/** A JSON column's value: DuckDB sends JSON as text, so it is parsed when it is a string. */
export function parseJsonCell(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Text for a cell, except timestamps (the viewer's timezone) and JSON (highlighted). Numbers the
 * API sent as strings (exact decimals, integers beyond 2^53) and identifier columns are shown
 * verbatim; other integers are grouped, and small fractions keep significant digits.
 */
export function formatCell(value: unknown, kind: CellKind, column = ""): string {
  if (value === null || value === undefined) return "—";
  if (kind === "number" && typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (identifier.test(column)) return String(value);
    if (Number.isInteger(value) || Math.abs(value) >= 1) return cellNumber.format(value);
    return value === 0 ? "0" : cellSmall.format(value);
  }
  if (kind === "date" && typeof value === "number") {
    const time = validTime(value);
    return time === null ? String(value) : new Date(time).toISOString().slice(0, 10);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Footer notes for a table: rows beyond the 500 shown, and the API's own truncation warnings. */
export function tableNotes(returned: number, warnings: Issue[]): string[] {
  const api = warnings
    .map((warning) => warning.message)
    .filter((message) => /^(Showing the first|The first row)/.test(message));
  const notes: string[] = [];
  if (returned > TABLE_ROW_LIMIT)
    notes.push(
      api.length
        ? `Showing the first ${TABLE_ROW_LIMIT} rows`
        : `Showing the first ${TABLE_ROW_LIMIT} of ${number(returned)} rows`,
    );
  return [...notes, ...api];
}

const binaryUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
function fixed(value: number, decimals: number | undefined, fallback: number) {
  return decimals === undefined
    ? number(value, fallback)
    : new Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
}

export function formatMeasure(
  value: number | null,
  view: Pick<View, "unit" | "decimals" | "prefix" | "suffix">,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const { unit = "number", decimals, prefix = "", suffix = "" } = view;
  let text: string;
  switch (unit) {
    case "ratio":
      text = `${fixed(value * 100, decimals, 1)}%`;
      break;
    case "percent":
      text = `${fixed(value, decimals, 1)}%`;
      break;
    case "ms":
      text = `${fixed(value, decimals, 2)} ms`;
      break;
    case "seconds":
      text = `${fixed(value, decimals, 2)} s`;
      break;
    case "bytes": {
      let scaled = Math.abs(value);
      let index = 0;
      while (scaled >= 1024 && index < binaryUnits.length - 1) {
        scaled /= 1024;
        index++;
      }
      const signed = value < 0 ? -scaled : scaled;
      text = `${fixed(signed, index === 0 ? (decimals ?? 0) : decimals, 1)} ${binaryUnits[index]}`;
      break;
    }
    default:
      text = fixed(value, decimals, 2);
  }
  return `${prefix}${text}${suffix}`;
}

/** Today's Overview as fixed, editable widgets. */
export function overviewTemplate(name: string): DashboardDocument {
  return {
    version: 1,
    name,
    widgets: [
      {
        id: "events",
        title: "Events",
        view: { type: "stat", sparkline: true, compare: "previous_period" },
        size: { w: 4, h: 1 },
        queries: { events: { signal: "events", measure: "count" } },
        series: [{ expr: "events", label: "Events", color: "yellow" }],
      },
      {
        id: "activity",
        title: "Activity",
        view: { type: "line", compare: "previous_period" },
        size: { w: 8, h: 2 },
        queries: { events: { signal: "events", measure: "count" } },
        series: [{ expr: "events", label: "Events", color: "yellow" }],
      },
      {
        id: "breakdown",
        title: "Top events",
        view: { type: "ranking", limit: 10 },
        queries: { events: { signal: "events", measure: "count", group_by: "name" } },
        series: [{ expr: "events", label: "Events", color: "yellow" }],
      },
      {
        id: "sources",
        title: "Sources",
        view: { type: "ranking", limit: 10 },
        queries: { events: { signal: "events", measure: "count", group_by: "source_id" } },
        series: [{ expr: "events", label: "Events", color: "violet" }],
      },
      {
        id: "actors",
        title: "Identified actors",
        description: "Identity kinds are counted separately. IDs are optional.",
        view: { type: "ranking", limit: 10 },
        queries: { actors: { signal: "events", measure: "actors", group_by: "identity_kind" } },
        series: [{ expr: "actors", label: "Actors", color: "aqua" }],
      },
      {
        id: "success",
        title: "Success rate",
        description: "Among events reporting a boolean success value",
        view: { type: "stat", unit: "percent", decimals: 1 },
        queries: {
          ok: {
            signal: "events",
            measure: "count",
            filters: [{ property: "success", op: "eq", value: true }],
          },
          failed: {
            signal: "events",
            measure: "count",
            filters: [{ property: "success", op: "eq", value: false }],
          },
        },
        series: [{ expr: "ok / (ok + failed) * 100", label: "Succeeded", color: "green" }],
      },
      {
        id: "duration",
        title: "Duration",
        description: "Only numeric duration_ms values are included",
        view: { type: "line", unit: "ms" },
        queries: {
          avg: { signal: "events", measure: "avg", property: "duration_ms" },
          p95: { signal: "events", measure: "p95", property: "duration_ms" },
        },
        series: [
          { expr: "avg", label: "Average", color: "yellow" },
          { expr: "p95", label: "p95", color: "violet" },
        ],
      },
    ],
  };
}
