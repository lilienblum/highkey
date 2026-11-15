// Parsing and rule checks for `piko.dashboard/v1` documents. `parse*` reports the first shape
// error (unknown fields, bad enum values) with its JSON Pointer path; `check*` reports every
// rule violation it finds. Ported from the Rust API's dashboards/validate.rs.
import { validKey } from "../queries/properties";
import schema from "./dashboard.v1.schema.json";
import { parseFormula, references } from "./formula";
import { SchemaParser, ShapeError } from "./shape";
import {
  type Document,
  type EventsQuery,
  effectiveCompare,
  type LogsQuery,
  type QuerySpec,
  readsLogs,
  type SqlQuery,
  seriesOrDefault,
  type Widget,
} from "./spec";

export const MAX_DOCUMENT_BYTES = 65_536;
export const MAX_SQL_CHARS = 8_000;
export const MAX_SQL_ROWS = 10_000;
export const MAX_TABLE_COLUMNS = 50;
export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

export const Limits = {
  MAX_DASHBOARDS_PER_PROJECT: 50,
  MAX_WIDGETS: 24,
  MAX_QUERIES_PER_WIDGET: 4,
  MAX_SERIES_PER_WIDGET: 4,
  MAX_QUERY_RUNS_PER_WIDGET: 8,
  WARN_QUERY_RUNS_PER_WIDGET: 4,
  WARN_QUERY_RUNS_PER_DOCUMENT: 40,
  MAX_GROUPED_SERIES: 6,
  MIN_RANKING_LIMIT: 1,
  MAX_RANKING_LIMIT: 50,
  DEFAULT_RANKING_LIMIT: 10,
  MAX_FILTERS: 8,
  MAX_EVENT_RANGE_DAYS: 366,
  MAX_HOURLY_RANGE_DAYS: 31,
  MAX_LOG_RANGE_DAYS: 31,
  MIN_TIMEOUT_MS: 1_000,
  MAX_TIMEOUT_MS: 10_000,
  DEFAULT_TIMEOUT_MS: 5_000,
  MAX_REVISIONS: 50,
  MAX_EXPRESSION_CHARS: 200,
  MAX_EXPRESSION_DEPTH: 16,
  MAX_ID_LEN: 40,
  MAX_QUERY_ID_LEN: 16,
  MAX_NAME_CHARS: 80,
  MAX_DESCRIPTION_CHARS: 280,
  MAX_MARKDOWN_CHARS: 2_000,
  MAX_AFFIX_CHARS: 8,
  MAX_DECIMALS: 4,
  SIZE_WIDTHS: [3, 4, 6, 8, 12],
  SIZE_HEIGHTS: [1, 2, 3],
  MAX_TEXT_FILTER_BYTES: 128,
  MAX_SEARCH_BYTES: 512,
} as const;

export function limitsJson() {
  return {
    max_dashboards_per_project: Limits.MAX_DASHBOARDS_PER_PROJECT,
    max_document_bytes: MAX_DOCUMENT_BYTES,
    max_widgets: Limits.MAX_WIDGETS,
    max_queries_per_widget: Limits.MAX_QUERIES_PER_WIDGET,
    max_series_per_widget: Limits.MAX_SERIES_PER_WIDGET,
    max_query_runs_per_widget: Limits.MAX_QUERY_RUNS_PER_WIDGET,
    max_grouped_series: Limits.MAX_GROUPED_SERIES,
    ranking_limit: {
      min: Limits.MIN_RANKING_LIMIT,
      max: Limits.MAX_RANKING_LIMIT,
      default: Limits.DEFAULT_RANKING_LIMIT,
    },
    max_filters: Limits.MAX_FILTERS,
    max_event_range_days: Limits.MAX_EVENT_RANGE_DAYS,
    max_hourly_range_days: Limits.MAX_HOURLY_RANGE_DAYS,
    max_log_range_days: Limits.MAX_LOG_RANGE_DAYS,
    timeout_ms: {
      min: Limits.MIN_TIMEOUT_MS,
      max: Limits.MAX_TIMEOUT_MS,
      default: Limits.DEFAULT_TIMEOUT_MS,
    },
    max_revisions: Limits.MAX_REVISIONS,
    max_expression_chars: Limits.MAX_EXPRESSION_CHARS,
    max_expression_depth: Limits.MAX_EXPRESSION_DEPTH,
    id_pattern: "[a-z0-9-]{1,40}",
    query_id_pattern: "[a-z][a-z0-9_]{0,15}",
    name_chars: { min: 1, max: Limits.MAX_NAME_CHARS },
    description_chars: { max: Limits.MAX_DESCRIPTION_CHARS },
    max_markdown_chars: Limits.MAX_MARKDOWN_CHARS,
    max_affix_chars: Limits.MAX_AFFIX_CHARS,
    decimals: { min: 0, max: Limits.MAX_DECIMALS },
    range_pattern: "^\\d{1,3}(h|d)$",
    size_widths: Limits.SIZE_WIDTHS,
    size_heights: Limits.SIZE_HEIGHTS,
    max_sql_chars: MAX_SQL_CHARS,
    max_sql_rows: MAX_SQL_ROWS,
    max_table_columns: MAX_TABLE_COLUMNS,
  };
}

export interface Issue {
  path: string;
  message: string;
  hint: string | null;
}

export class Report {
  errors: Issue[] = [];
  warnings: Issue[] = [];
  get ok(): boolean {
    return this.errors.length === 0;
  }
  error(path: string, message: string, hint: string | null = null): void {
    this.errors.push({ path, message, hint });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message, hint: null });
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; report: Report };

const parser = new SchemaParser(schema);

function parseWith<T>(definition: unknown, value: unknown): Parsed<T> {
  try {
    return { ok: true, value: parser.parse(definition, value) as T };
  } catch (error) {
    if (!(error instanceof ShapeError)) throw error;
    const report = new Report();
    report.error(error.path, error.message);
    return { ok: false, report };
  }
}

export const parseDocument = (value: unknown) => parseWith<Document>(schema, value);
export const parseWidget = (value: unknown) => parseWith<Widget>({ $ref: "#/$defs/Widget" }, value);
export const parseQuery = (value: unknown) =>
  parseWith<QuerySpec>({ $ref: "#/$defs/QuerySpec" }, value);

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => prune(item));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    if ((k === "filters" || k === "thresholds") && Array.isArray(v) && v.length === 0) continue;
    out[k] = prune(v);
  }
  return out;
}

/** The document as stored and measured: absent optional fields dropped, defaults kept. */
export function serializeDocument(doc: Document): string {
  return JSON.stringify(prune(doc));
}

const chars = (s: string) => [...s].length;
const bytes = (s: string) => new TextEncoder().encode(s).length;

function textLength(r: Report, path: string, s: string, min: number, max: number, what: string) {
  const n = chars(s);
  if (n < min || n > max) r.error(path, `${what} must be ${min}–${max} characters`);
}

function queryRuns(w: Widget): number {
  return Object.keys(w.queries).length * (effectiveCompare(w.view) ? 2 : 1);
}

export function checkDocument(doc: Document): Report {
  const r = new Report();
  const size = bytes(serializeDocument(doc));
  if (size > MAX_DOCUMENT_BYTES)
    r.error("", `Document is ${size} bytes; the limit is ${MAX_DOCUMENT_BYTES}`);
  if (doc.version !== 1) r.error("/version", "Only version 1 is supported");
  textLength(r, "/name", doc.name, 1, Limits.MAX_NAME_CHARS, "name");
  if (doc.description && chars(doc.description) > Limits.MAX_DESCRIPTION_CHARS)
    r.error("/description", `description is limited to ${Limits.MAX_DESCRIPTION_CHARS} characters`);
  if (doc.widgets.length > Limits.MAX_WIDGETS)
    r.error("/widgets", `A dashboard holds at most ${Limits.MAX_WIDGETS} widgets`);
  const seen = new Set<string>();
  let runs = 0;
  doc.widgets.forEach((widget, i) => {
    if (seen.has(widget.id)) r.error(`/widgets/${i}/id`, `Duplicate widget id \`${widget.id}\``);
    seen.add(widget.id);
    checkWidget(widget, `/widgets/${i}`, r);
    runs += queryRuns(widget);
  });
  if (runs > Limits.WARN_QUERY_RUNS_PER_DOCUMENT)
    r.warn(
      "/widgets",
      `The dashboard runs ${runs} queries per refresh (more than ${Limits.WARN_QUERY_RUNS_PER_DOCUMENT}); it may load slowly`,
    );
  return r;
}

const validWidgetId = (id: string) => /^[a-z0-9-]{1,40}$/.test(id);
const validQueryId = (id: string) => /^[a-z][a-z0-9_]{0,15}$/.test(id);

/** A range override in hours: `^\d{1,3}(h|d)$`, non-zero. */
export function rangeHours(s: string): number | null {
  const match = /^(\d{1,3})([hd])$/.exec(s);
  if (!match) return null;
  const n = Number(match[1]);
  if (n === 0) return null;
  return match[2] === "h" ? n : n * 24;
}

export function checkWidget(w: Widget, base: string, r: Report): void {
  if (!validWidgetId(w.id)) r.error(`${base}/id`, "id must match [a-z0-9-]{1,40}");
  textLength(r, `${base}/title`, w.title, 1, Limits.MAX_NAME_CHARS, "title");
  if (w.description && chars(w.description) > Limits.MAX_DESCRIPTION_CHARS)
    r.error(
      `${base}/description`,
      `description is limited to ${Limits.MAX_DESCRIPTION_CHARS} characters`,
    );
  if (w.size) {
    if (!(Limits.SIZE_WIDTHS as readonly number[]).includes(w.size.w))
      r.error(`${base}/size/w`, "w must be one of 3, 4, 6, 8, 12");
    if (!(Limits.SIZE_HEIGHTS as readonly number[]).includes(w.size.h))
      r.error(`${base}/size/h`, "h must be one of 1, 2, 3");
  }
  if (
    w.timeout_ms != null &&
    (w.timeout_ms < Limits.MIN_TIMEOUT_MS || w.timeout_ms > Limits.MAX_TIMEOUT_MS)
  )
    r.error(`${base}/timeout_ms`, "timeout_ms must be 1000–10000");
  const hasLogs = Object.values(w.queries).some(readsLogs);
  let hours: number | null = null;
  if (w.range != null) {
    hours = rangeHours(w.range);
    if (hours === null)
      r.error(
        `${base}/range`,
        `Invalid range \`${w.range}\``,
        "Use 1–3 digits and h or d, such as 24h or 30d",
      );
    else if (hours > Limits.MAX_EVENT_RANGE_DAYS * 24)
      r.warn(`${base}/range`, "Ranges are limited to 366 days; this range will be clamped");
    else if (hasLogs && hours > Limits.MAX_LOG_RANGE_DAYS * 24)
      r.warn(
        `${base}/range`,
        "Ranges with a logs query are limited to 31 days; this range will be clamped",
      );
  }
  checkView(w, base, hours, r);
  for (const [id, query] of Object.entries(w.queries)) {
    if (!validQueryId(id))
      r.error(`${base}/queries/${id}`, "Query ids must match [a-z][a-z0-9_]{0,15}");
    checkQuery(query, `${base}/queries/${id}`, r);
  }
  checkShape(w, base, r);
}

function checkView(w: Widget, base: string, range: number | null, r: Report) {
  const v = w.view;
  const vp = `${base}/view`;
  if (v.decimals != null && v.decimals > Limits.MAX_DECIMALS)
    r.error(`${vp}/decimals`, "decimals must be 0–4");
  for (const name of ["prefix", "suffix"] as const) {
    const value = v[name];
    if (value != null && chars(value) > Limits.MAX_AFFIX_CHARS)
      r.error(`${vp}/${name}`, `${name} is limited to 8 characters`);
  }
  if (v.bucket != null) {
    if (!["auto", "hour", "day", "week", "month"].includes(v.bucket))
      r.error(`${vp}/bucket`, "bucket must be auto, hour, day, week or month");
    else if (v.bucket === "hour" && range !== null && range > Limits.MAX_HOURLY_RANGE_DAYS * 24)
      r.warn(
        `${vp}/bucket`,
        "Hourly buckets need a range of at most 31 days; the bucket falls back to auto",
      );
  }
  if (v.limit != null && (v.limit < Limits.MIN_RANKING_LIMIT || v.limit > Limits.MAX_RANKING_LIMIT))
    r.error(`${vp}/limit`, "limit must be 1–50");
  if (v.type === "text") {
    if (v.markdown == null) r.error(`${vp}/markdown`, "Text widgets need markdown");
    else if (chars(v.markdown) > Limits.MAX_MARKDOWN_CHARS)
      r.error(`${vp}/markdown`, "markdown is limited to 2000 characters");
  } else if (v.markdown != null) r.error(`${vp}/markdown`, "markdown is only for text widgets");
}

function groupBy(q: QuerySpec): string | null {
  return q.signal === "sql" ? null : (q.group_by ?? null);
}

function checkShape(w: Widget, base: string, r: Report) {
  const kind = w.view.type;
  const entries = Object.entries(w.queries);
  const n = entries.length;
  const qpath = `${base}/queries`;
  if (kind === "text") {
    if (n > 0) r.error(qpath, "Text widgets take no queries");
    if (w.series != null) r.error(`${base}/series`, "Text widgets take no series");
    return;
  }
  if (kind === "table") {
    const sql = entries.filter(([, q]) => q.signal === "sql").length;
    if (n !== 1 || sql !== 1)
      r.error(
        qpath,
        "A table widget needs exactly one SQL query",
        'Give the widget one query with "signal": "sql"',
      );
    if (w.series != null)
      r.error(
        `${base}/series`,
        "A table widget takes no series",
        "Remove series; the table shows the query's columns",
      );
    return;
  }
  if (kind === "events" || kind === "logs") {
    if (n !== 1) r.error(qpath, `A ${kind} widget needs exactly one ${kind} query`);
    for (const [id, q] of entries) {
      if (q.signal !== kind) {
        r.error(`${qpath}/${id}`, `A ${kind} widget needs a ${kind} query`);
        continue;
      }
      if (q.measure !== "count")
        r.error(`${qpath}/${id}/measure`, `A ${kind} widget lists rows and takes no measure`);
      if (q.group_by != null)
        r.error(`${qpath}/${id}/group_by`, `A ${kind} widget lists rows and takes no group_by`);
    }
    if (w.series != null) r.error(`${base}/series`, `A ${kind} widget takes no series`);
    return;
  }
  if (n < 1 || n > Limits.MAX_QUERIES_PER_WIDGET) r.error(qpath, "A widget needs 1–4 queries");
  const runs = queryRuns(w);
  if (runs > Limits.MAX_QUERY_RUNS_PER_WIDGET)
    r.error(qpath, `${runs} query runs per refresh including the previous period; the limit is 8`);
  else if (runs > Limits.WARN_QUERY_RUNS_PER_WIDGET)
    r.warn(
      qpath,
      `${runs} query runs per refresh including the previous period; this widget may load slowly`,
    );
  const typed = entries.filter(([, q]) => q.signal !== "sql");
  if (typed.length > 0) {
    const first = groupBy((typed[0] as [string, QuerySpec])[1]);
    for (const [id, q] of typed.slice(1))
      if (groupBy(q) !== first)
        r.error(
          `${qpath}/${id}/group_by`,
          "Every query in a widget must share the same group_by",
          "Give all queries the same group_by, or remove it from all of them",
        );
  }
  const grouped = n > 0 && groupBy((entries[0] as [string, QuerySpec])[1]) !== null;
  if (kind === "ranking")
    for (const [id, q] of entries)
      if (q.signal !== "sql" && groupBy(q) === null)
        r.error(`${qpath}/${id}/group_by`, "Ranking widgets need a group_by");
  const series = seriesOrDefault(w);
  const spath = `${base}/series`;
  if (w.series != null && (series.length < 1 || series.length > Limits.MAX_SERIES_PER_WIDGET))
    r.error(spath, "A widget needs 1–4 series");
  if (grouped && ["line", "area", "bar"].includes(kind) && series.length > 1)
    r.error(
      w.series != null ? `${spath}/1` : qpath,
      "A grouped time series allows only one series",
      "Remove the extra series, or remove group_by",
    );
  const known = Object.keys(w.queries);
  const referenced = new Set<string>();
  let allParsed = true;
  series.forEach((s, i) => {
    const sp = `${spath}/${i}`;
    const result = parseFormula(s.expr, known);
    if (result.ok) for (const id of references(result.expr)) referenced.add(id);
    else {
      allParsed = false;
      const split = result.error.message.indexOf("; ");
      const message =
        split >= 0
          ? `${result.error.message.slice(0, split)} at column ${result.error.column}; ${result.error.message.slice(split + 2)}`
          : `${result.error.message} at column ${result.error.column}`;
      r.error(`${sp}/expr`, message);
    }
    (s.thresholds ?? []).forEach((threshold, j, all) => {
      const previous = all[j - 1];
      if (previous && threshold.at <= previous.at)
        r.error(`${sp}/thresholds/${j}`, "Thresholds must be in ascending order");
    });
  });
  if (allParsed)
    for (const id of known)
      if (!referenced.has(id))
        r.error(
          `${qpath}/${id}`,
          `Query \`${id}\` is not used by any series`,
          "Reference it in a series expression, or remove it",
        );
}

function nonEmpty(r: Report, path: string, value: string | null | undefined, max: number) {
  if (value != null && (value.length === 0 || bytes(value) > max))
    r.error(path, `Must be 1–${max} bytes`);
}

function checkQuery(q: QuerySpec, p: string, r: Report) {
  if (q.signal === "events") checkEvents(q, p, r);
  else if (q.signal === "logs") checkLogs(q, p, r);
  else checkSql(q, p, r);
}

/** The size of the text. What the SQL does is verified by ClickHouse (see sql.ts). */
function checkSql(q: SqlQuery, p: string, r: Report) {
  const n = chars(q.sql);
  if (!q.sql.trim())
    r.error(
      `${p}/sql`,
      "sql is empty",
      "Write one SELECT, such as SELECT count() AS value FROM events",
    );
  else if (n > MAX_SQL_CHARS)
    r.error(
      `${p}/sql`,
      `sql is ${n} characters; the limit is ${MAX_SQL_CHARS}`,
      "Shorten the query, for example by naming repeated parts in a WITH clause",
    );
}

export function checkEvents(q: EventsQuery, p: string, r: Report): void {
  for (const name of ["event", "source_id", "identity_kind"] as const)
    nonEmpty(r, `${p}/${name}`, q[name], Limits.MAX_TEXT_FILTER_BYTES);
  checkMeasure(!["count", "actors"].includes(q.measure), q.property, "property", validKey, p, r);
  const filters = q.filters ?? [];
  if (filters.length > Limits.MAX_FILTERS) r.error(`${p}/filters`, "At most 8 filters per query");
  filters.forEach((f, i) => {
    const fp = `${p}/filters/${i}`;
    if (!validKey(f.property)) r.error(`${fp}/property`, "Invalid property key");
    if (!["eq", "ne", "gt", "gte", "lt", "lte"].includes(f.op))
      r.error(`${fp}/op`, "op must be eq, ne, gt, gte, lt or lte");
    else if (typeof f.value !== "number") {
      if (typeof f.value !== "string" && typeof f.value !== "boolean")
        r.error(`${fp}/value`, "value must be a string, number or boolean");
      else if (!["eq", "ne"].includes(f.op))
        r.error(`${fp}/value`, "Ordered comparisons require a number");
    }
  });
  if (q.group_by != null) {
    const g = q.group_by;
    const ok =
      ["name", "source", "source_id", "identity_kind"].includes(g) ||
      (g.startsWith("property:") && validKey(g.slice(9)));
    if (!ok)
      r.error(
        `${p}/group_by`,
        `Invalid group_by \`${g}\``,
        "Use name, source, source_id, identity_kind or property:<key>",
      );
  }
}

const attributeKey = (s: string) => s.length > 0 && bytes(s) <= 128;

export function checkLogs(q: LogsQuery, p: string, r: Report): void {
  for (const name of ["level", "min_level"] as const) {
    const value = q[name];
    if (value != null && !LEVELS.includes(value))
      r.error(`${p}/${name}`, "Unknown log level", LEVELS.join(", "));
  }
  if (
    q.min_level != null &&
    LEVELS.includes(q.min_level) &&
    !["warn", "error", "fatal"].includes(q.min_level)
  )
    r.error(`${p}/min_level`, "min_level must be warn, error or fatal");
  if (q.level != null && q.min_level != null)
    r.error(`${p}/min_level`, "Use either level or min_level, not both");
  for (const name of ["service", "environment", "source_id"] as const)
    nonEmpty(r, `${p}/${name}`, q[name], Limits.MAX_TEXT_FILTER_BYTES);
  if (q.search != null && bytes(q.search) > Limits.MAX_SEARCH_BYTES)
    r.error(`${p}/search`, "search is limited to 512 bytes");
  const filters = q.filters ?? [];
  if (filters.length > Limits.MAX_FILTERS) r.error(`${p}/filters`, "At most 8 filters per query");
  filters.forEach((f, i) => {
    const fp = `${p}/filters/${i}`;
    if (!attributeKey(f.attribute)) r.error(`${fp}/attribute`, "attribute must be 1–128 bytes");
    const scalar =
      typeof f.value === "string"
        ? bytes(f.value) <= Limits.MAX_SEARCH_BYTES
        : typeof f.value === "number" || typeof f.value === "boolean";
    if (!scalar) r.error(`${fp}/value`, "value must be a string (≤512 bytes), number or boolean");
  });
  checkMeasure(q.measure !== "count", q.attribute, "attribute", attributeKey, p, r);
  if (q.group_by != null) {
    const g = q.group_by;
    const ok =
      ["level", "service", "environment"].includes(g) ||
      (g.startsWith("attribute:") && attributeKey(g.slice(10)));
    if (!ok)
      r.error(
        `${p}/group_by`,
        `Invalid group_by \`${g}\``,
        "Use level, service, environment or attribute:<key>",
      );
  }
}

function checkMeasure(
  numeric: boolean,
  field: string | null | undefined,
  name: string,
  valid: (s: string) => boolean,
  p: string,
  r: Report,
) {
  if (numeric && field == null) r.error(`${p}/${name}`, `This measure needs a ${name}`);
  else if (numeric && field != null && !valid(field)) r.error(`${p}/${name}`, `Invalid ${name}`);
  else if (!numeric && field != null)
    r.error(`${p}/${name}`, `${name} is only used by sum, avg, p50, p95, min and max`);
}
