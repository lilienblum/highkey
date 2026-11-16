// The `piko.dashboard/v1` document, as parsed (schema defaults filled in).

export type ViewKind =
  | "stat"
  | "line"
  | "area"
  | "bar"
  | "ranking"
  | "events"
  | "logs"
  | "text"
  | "table";
export type Unit = "number" | "percent" | "ratio" | "ms" | "seconds" | "bytes";
export type Color = "yellow" | "violet" | "aqua" | "green" | "red" | "neutral";

export interface View {
  type: ViewKind;
  unit?: Unit | null;
  decimals?: number | null;
  prefix?: string | null;
  suffix?: string | null;
  sparkline?: boolean | null;
  compare?: "previous_period" | "none" | null;
  better?: "up" | "down" | null;
  bucket?: string | null;
  stacked?: boolean | null;
  limit?: number | null;
  markdown?: string | null;
}

export interface Filter {
  property: string;
  op: string;
  value: unknown;
}

export interface LogFilter {
  attribute: string;
  value: unknown;
}

export interface EventsQuery {
  signal: "events";
  event?: string | null;
  source_id?: string | null;
  identity_kind?: string | null;
  measure: "count" | "actors" | "sum" | "avg" | "p50" | "p95" | "min" | "max";
  property?: string | null;
  filters?: Filter[];
  group_by?: string | null;
}

export interface LogsQuery {
  signal: "logs";
  level?: string | null;
  min_level?: string | null;
  service?: string | null;
  environment?: string | null;
  source_id?: string | null;
  search?: string | null;
  filters?: LogFilter[];
  measure: "count" | "sum" | "avg" | "p50" | "p95" | "min" | "max";
  attribute?: string | null;
  group_by?: string | null;
}

/** One event, with optional property filters: a funnel step, or a retention start or return. */
export interface Step {
  event: string;
  filters?: Filter[];
}

export interface FunnelQuery {
  signal: "funnel";
  steps: Step[];
  window: string;
  by: "actor" | "session";
  source_id?: string | null;
}

export type Period = "day" | "week" | "month";

export interface RetentionQuery {
  signal: "retention";
  start: Step;
  return: Step;
  period: Period;
  periods: number;
  source_id?: string | null;
}

export type QuerySpec = EventsQuery | LogsQuery | FunnelQuery | RetentionQuery;

/** Events and logs: the queries that measure totals, buckets and groups. */
export type TypedQuery = EventsQuery | LogsQuery;
export const typed = (q: QuerySpec): q is TypedQuery =>
  q.signal === "events" || q.signal === "logs";

export interface Threshold {
  at: number;
  color: Color;
}

export interface Series {
  expr: string;
  label?: string | null;
  color?: Color | null;
  unit?: Unit | null;
  thresholds?: Threshold[];
}

export interface Widget {
  id: string;
  title: string;
  description?: string | null;
  view: View;
  size?: { w: number; h: number } | null;
  range?: string | null;
  timeout_ms?: number | null;
  queries: Record<string, QuerySpec>;
  series?: Series[] | null;
}

export interface Document {
  $schema?: string | null;
  version: number;
  name: string;
  description?: string | null;
  widgets: Widget[];
}

export const SCHEMA_ID = "/api/read/schemas/dashboard.v1.json";

export function readsLogs(q: QuerySpec): boolean {
  return q.signal === "logs";
}

/** The comparison a view runs: stat, line, area and bar compare with the previous period unless `none`. */
export function effectiveCompare(view: View): "previous_period" | null {
  if (view.compare === "previous_period") return "previous_period";
  if (view.compare === "none") return null;
  return ["stat", "line", "area", "bar"].includes(view.type) ? "previous_period" : null;
}

/** The good direction of change: written `better`, else down for durations, else up. */
export function effectiveBetter(view: View, seriesUnit?: Unit | null): "up" | "down" {
  if (view.better) return view.better;
  const unit = seriesUnit ?? view.unit;
  return unit === "ms" || unit === "seconds" ? "down" : "up";
}

/** Explicit series, or one per query when none are written. Row and text views have none. */
export function seriesOrDefault(w: Widget): Series[] {
  if (["events", "logs", "text", "table"].includes(w.view.type)) return [];
  return w.series ?? Object.keys(w.queries).map((id) => ({ expr: id }));
}

export function defaultSize(w: Widget): { w: number; h: number } {
  switch (w.view.type) {
    case "stat":
      return { w: 3, h: 1 };
    case "events":
    case "logs":
    case "table":
      return { w: 12, h: 3 };
    case "text":
      return { w: 4, h: 1 };
    default:
      return { w: 6, h: 2 };
  }
}
