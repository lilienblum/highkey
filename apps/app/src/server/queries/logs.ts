// The Logs page's query: 60 summary buckets, top services, facets, and pages of records by a
// stable (timestamp, log_id) cursor, over the project's `logs` view. Matches logs/query.rs.
import { bad } from "../api/errors";
import { fields } from "../api/body";
import { runSettings } from "../clickhouse/access";
import type { ClickHouse } from "../clickhouse/client";
import { filterCondition, Params, typedValue, validKey } from "./properties";

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const DAY = 86_400_000;

export interface LogFilter {
  attribute: string;
  /** Absent means eq; the Logs page sends only equalities. */
  op?: string | null;
  value?: unknown;
}

export interface LogsQuery {
  from: Date;
  to: Date;
  source_id?: string | null;
  level?: string | null;
  min_level?: string | null;
  service?: string | null;
  environment?: string | null;
  search?: string | null;
  trace_id?: string | null;
  request_id?: string | null;
  filters: LogFilter[];
  cursor?: { timestamp: number; log_id: string } | null;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function time(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(parsed.getTime()))
    throw bad(`${name} must be an RFC 3339 time`);
  return parsed;
}

export function parseLogsQuery(body: unknown): LogsQuery {
  const input = fields(body, {
    from: "string",
    to: "string",
    source_id: "string?",
    level: "string?",
    min_level: "string?",
    service: "string?",
    environment: "string?",
    search: "string?",
    trace_id: "string?",
    request_id: "string?",
    filters: "unknown",
    cursor: "unknown",
  });
  const filters =
    input.filters == null
      ? []
      : Array.isArray(input.filters)
        ? input.filters.map(
            (f) => fields(f, { attribute: "string", value: "unknown" }) as LogFilter,
          )
        : (() => {
            throw bad("Provide at most eight typed scalar attribute filters");
          })();
  const cursor =
    input.cursor == null
      ? null
      : (fields(input.cursor, { timestamp: "integer", log_id: "string" }) as LogsQuery["cursor"]);
  const query: LogsQuery = {
    ...input,
    from: time(input.from, "from"),
    to: time(input.to, "to"),
    filters,
    cursor,
  };
  validateLogsQuery(query);
  return query;
}

export function validateLogsQuery(q: LogsQuery): void {
  const span = q.to.getTime() - q.from.getTime();
  if (span <= 0 || span > 31 * DAY)
    throw bad("Log query range must be positive and at most 31 days");
  for (const level of [q.level, q.min_level])
    if (level != null && !(LEVELS as readonly string[]).includes(level))
      throw bad("Invalid log level");
  if (q.level != null && q.min_level != null) throw bad("Use either level or min_level, not both");
  for (const text of [q.service, q.environment, q.trace_id, q.request_id])
    if (text != null && (text.length === 0 || bytes(text) > 128))
      throw bad("Filter values require 1–128 bytes");
  if (q.search != null && bytes(q.search) > 512) throw bad("Search is limited to 512 bytes");
  if (
    q.cursor &&
    (!validKey(q.cursor.log_id) ||
      q.cursor.timestamp < q.from.getTime() ||
      q.cursor.timestamp >= q.to.getTime())
  )
    throw bad("Invalid log cursor");
  if (
    q.filters.length > 8 ||
    q.filters.some(
      (f) =>
        f.attribute.length === 0 ||
        bytes(f.attribute) > 128 ||
        !["string", "number", "boolean"].includes(typeof f.value) ||
        (typeof f.value === "string" && bytes(f.value) > 512),
    )
  )
    throw bad("Provide at most eight typed scalar attribute filters");
}

/** A top-level attribute, by name; dots inside a name are stored escaped. */
export function attribute(name: string, params: Params): string {
  return `getSubcolumn(attributes, ${params.add("String", name.replaceAll(".", "%2E"))})`;
}

/** Conditions shared by the log list and log widgets; the view already holds range and source. */
export function logConditions(
  q: Pick<
    LogsQuery,
    | "level"
    | "min_level"
    | "service"
    | "environment"
    | "trace_id"
    | "request_id"
    | "search"
    | "filters"
  >,
  params: Params,
): string[] {
  const conditions: string[] = [];
  for (const [column, value] of [
    ["level", q.level],
    ["service", q.service],
    ["environment", q.environment],
    ["trace_id", q.trace_id],
    ["request_id", q.request_id],
  ] as const)
    if (value != null) conditions.push(`${column} = ${params.add("String", value)}`);
  if (q.search)
    conditions.push(`positionCaseInsensitiveUTF8(message, ${params.add("String", q.search)}) > 0`);
  for (const filter of q.filters)
    conditions.push(
      filterCondition(attribute(filter.attribute, params), filter.op, filter.value, params),
    );
  if (q.min_level) {
    const levels = LEVELS.slice(LEVELS.indexOf(q.min_level as (typeof LEVELS)[number]));
    conditions.push(`level IN (${levels.map((level) => params.add("String", level)).join(", ")})`);
  }
  return conditions;
}

interface Facets {
  services: { name: string; count: number }[];
  environments: { name: string; count: number }[];
  attributes: { key: string; type: string; count: number }[];
}

const SCALARS: Record<string, string> = {
  String: "string",
  Int64: "number",
  UInt64: "number",
  Float64: "number",
  Bool: "boolean",
};

export async function facets(
  reader: ClickHouse,
  settings: Record<string, string>,
): Promise<Facets> {
  const top = (column: string) =>
    reader.query<{ name: string; count: number }>(
      `SELECT ${column} AS name, count() AS count FROM logs WHERE ${column} IS NOT NULL GROUP BY name ORDER BY count DESC, name LIMIT 50`,
      { settings },
    );
  const services = (await top("service")).data;
  const environments = (await top("environment")).data;
  // Attribute keys come from the newest 1,000 records, so the cost stays bounded while Follow
  // refreshes. Nested paths and arrays cannot be matched, so they are not offered.
  const paths = await reader.query<{ path: string; type: string; count: number }>(
    "SELECT pt.1 AS path, pt.2 AS type, count() AS count FROM (SELECT arrayJoin(JSONAllPathsWithTypes(attributes)) AS pt FROM (SELECT attributes FROM logs ORDER BY timestamp DESC LIMIT 1000)) GROUP BY path, type",
    { settings },
  );
  const keys = new Map<string, { count: number; best: number; type: string }>();
  for (const row of paths.data) {
    if (row.path.includes(".")) continue;
    const key = row.path.replaceAll("%2E", ".");
    const entry = keys.get(key) ?? { count: 0, best: 0, type: "" };
    entry.count += Number(row.count);
    const scalar = SCALARS[row.type];
    if (scalar && Number(row.count) > entry.best) {
      entry.best = Number(row.count);
      entry.type = scalar;
    }
    keys.set(key, entry);
  }
  const attributes = [...keys.entries()]
    .filter(([, entry]) => entry.type)
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .slice(0, 100)
    .map(([key, entry]) => ({ key, type: entry.type, count: entry.count }));
  return {
    services: services.map((s) => ({ name: s.name, count: Number(s.count) })),
    environments: environments.map((e) => ({ name: e.name, count: Number(e.count) })),
    attributes,
  };
}

export async function runLogsQuery(reader: ClickHouse, q: LogsQuery) {
  validateLogsQuery(q);
  const settings = runSettings({
    from: q.from,
    to: q.to,
    source: q.source_id ?? null,
    bucket: "day",
  });
  const facetsResult = q.cursor ? null : await facets(reader, settings);
  const params = new Params();
  const conditions = logConditions(q, params);
  const where = conditions.length ? conditions.join(" AND ") : "1";
  const from = q.from.getTime();
  const width = Math.max(1, Math.floor((q.to.getTime() - from) / 60));
  const series = Array.from({ length: 60 }, (_, index) => ({
    time: from + index * width,
    count: 0,
    errors: 0,
  }));
  const buckets = await reader.query<{ bucket: number; count: number; errors: number }>(
    `SELECT least(59, intDiv(toUnixTimestamp64Milli(timestamp) - ${params.add("Int64", from)}, ${params.add("Int64", width)})) AS bucket, count() AS count, countIf(level IN ('error', 'fatal')) AS errors FROM logs WHERE ${where} GROUP BY bucket`,
    { params: params.values, settings },
  );
  let total = 0;
  for (const row of buckets.data) {
    const item = series[Number(row.bucket)];
    if (!item) continue;
    item.count = Number(row.count);
    item.errors = Number(row.errors);
    total += item.count;
  }
  const services = await reader.query<{ name: string; count: number }>(
    `SELECT service AS name, count() AS count FROM logs WHERE ${where} GROUP BY name ORDER BY count DESC, name LIMIT 50`,
    { params: params.values, settings },
  );
  let page = where;
  if (q.cursor) {
    const at = params.add("Int64", q.cursor.timestamp);
    page += ` AND (toUnixTimestamp64Milli(timestamp) < ${at} OR (toUnixTimestamp64Milli(timestamp) = ${at} AND log_id < ${params.add("String", q.cursor.log_id)}))`;
  }
  const rows = await reader.query<Record<string, unknown>>(
    // Page in a subquery: the outer aliases reuse column names the filters must not see.
    `SELECT log_id, toString(source_id) AS source_id, toUnixTimestamp64Milli(timestamp) AS timestamp, toUnixTimestamp64Milli(received_at) AS received_at, toString(level) AS level, message, service, environment, trace_id, span_id, request_id, attributes FROM (SELECT * FROM logs WHERE ${page} ORDER BY timestamp DESC, log_id DESC LIMIT 101) ORDER BY timestamp DESC, log_id DESC`,
    { params: params.values, settings },
  );
  const logs = rows.data.slice(0, 100);
  const last = logs.at(-1);
  return {
    logs,
    next_cursor:
      rows.data.length > 100 && last ? { timestamp: last.timestamp, log_id: last.log_id } : null,
    total,
    series,
    services: services.data.map((s) => ({ name: s.name, count: Number(s.count) })),
    facets: facetsResult,
  };
}

export { typedValue };
