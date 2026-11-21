// The Explore page's query: a summary, a bucketed series, top groups, a page of events and the
// event names, all over the project's `events` view. Behaviour matches the Rust API's query.rs.
import { bad } from "../api/errors";
import { fields } from "../api/body";
import { type Bucket, runSettings } from "../clickhouse/access";
import type { ClickHouse } from "../clickhouse/client";
import {
  bucketGrid,
  distinctValues,
  filterCondition,
  numeric,
  Params,
  path,
  typedValue,
  validKey,
} from "./properties";

export interface Filter {
  property: string;
  op: string;
  value?: unknown;
}

export interface EventsQuery {
  names?: string[];
  order?: string;
  from: Date;
  to: Date;
  bucket: Bucket;
  event?: string | null;
  source?: string | null;
  source_id?: string | null;
  identity_kind?: string | null;
  measure: string;
  property?: string | null;
  group_by?: string | null;
  filters: Filter[];
  page: number;
  page_size: number;
}

const LIMITS =
  "Use minute/hour/day/week/month buckets, a positive range ≤366 days (per minute ≤1 hour, hourly ≤31 days), page ≤10000, page_size 1–100, and ≤8 filters";
const NUMERIC = ["sum", "avg", "p50", "p95", "min", "max"];
/** The measures the Events page runs. */
export const MEASURES = ["count", "actors", ...NUMERIC];
/** The filter ops the Events page runs. */
export const EVENTS_PAGE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte"];
const DAY = 86_400_000;

function time(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(parsed.getTime()))
    throw bad(`${name} must be an RFC 3339 time`);
  return parsed;
}

export function parseFilters(value: unknown): Filter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad("filters must be an array");
  return value.map(
    (filter) => fields(filter, { property: "string", op: "string", value: "unknown" }) as Filter,
  );
}

/** Parses and validates a request body, with the Rust API's messages. */
export function parseEventsQuery(body: unknown): EventsQuery {
  const input = fields(
    body,
    {
      from: "string",
      order: "string",
      to: "string",
      bucket: "string",
      event: "string?",
      names: "string[]",
      source: "string?",
      source_id: "string?",
      identity_kind: "string?",
      measure: "string",
      property: "string?",
      group_by: "string?",
      filters: "unknown",
      page: "integer",
      page_size: "integer",
    },
    { bucket: "day", measure: "count", page: 0, page_size: 25, order: "newest", names: [] },
  );
  const query: EventsQuery = {
    ...input,
    from: time(input.from, "from"),
    to: time(input.to, "to"),
    bucket: input.bucket as Bucket,
    filters: parseFilters(input.filters),
  };
  validateEventsQuery(query);
  return query;
}

export function validateEventsQuery(q: EventsQuery): void {
  const span = q.to.getTime() - q.from.getTime();
  if (
    span <= 0 ||
    span > 366 * DAY ||
    !["minute", "hour", "day", "week", "month"].includes(q.bucket) ||
    (q.bucket === "minute" && span > 3_600_000) ||
    (q.bucket === "hour" && span > 31 * DAY) ||
    q.page_size === 0 ||
    q.page_size > 100 ||
    q.page > 10_000 ||
    q.page < 0 ||
    q.filters.length > 8
  )
    throw bad(LIMITS);
  if (!MEASURES.includes(q.measure)) throw bad("Unsupported measure");
  if (q.names && (q.names.length > 500 || q.names.some((name) => !validKey(name))))
    throw bad("Use up to 500 valid event names");
  if (q.order !== undefined && !["oldest", "newest"].includes(q.order))
    throw bad("Order must be oldest or newest");
  if (NUMERIC.includes(q.measure)) {
    if (!q.property) throw bad("Numeric measures need a property");
    path("properties", q.property);
  }
}

/** The aggregate a measure stands for. */
export function measure(q: { measure: string; property?: string | null }): string {
  const number = () => numeric(path("properties", q.property as string));
  switch (q.measure) {
    case "actors":
      return "uniqExactIf((identity_kind, actor_id), actor_id IS NOT NULL)";
    case "sum":
    case "avg":
    case "min":
    case "max":
      return `${q.measure}OrNull(${number()})`;
    case "p50":
      return `quantileExactInclusiveOrNull(0.5)(${number()})`;
    case "p90":
      return `quantileExactInclusiveOrNull(0.9)(${number()})`;
    case "p95":
      return `quantileExactInclusiveOrNull(0.95)(${number()})`;
    case "p99":
      return `quantileExactInclusiveOrNull(0.99)(${number()})`;
    case "unique":
      return distinctValues(path("properties", q.property as string));
    case "sessions":
      return "uniqExactIf(session_id, session_id IS NOT NULL)";
    default:
      return "count()";
  }
}

/** The WHERE clause for the query's own filters; the view already holds its range and source. */
export function predicate(q: EventsQuery, params: Params): string {
  const parts = ["1"];
  if (q.names?.length) parts.push(`name IN ${params.addList(q.names)}`);
  for (const [column, value] of [
    ["name", q.event],
    ["source", q.source],
    ["identity_kind", q.identity_kind],
  ] as const)
    if (value != null) parts.push(`${column} = ${params.add("String", value)}`);
  for (const filter of q.filters)
    parts.push(
      filterCondition(path("properties", filter.property), filter.op, filter.value, params),
    );
  return parts.join(" AND ");
}

function group(q: EventsQuery): { select: string; by: string; property: boolean } {
  const by = q.group_by ?? "name";
  if (["name", "source", "identity_kind"].includes(by))
    return { select: `'String' AS t, toString(${by}) AS s`, by: "t, s", property: false };
  if (by === "source_id")
    return { select: "'String' AS t, toString(source_id) AS s", by: "t, s", property: false };
  if (by.startsWith("property:") && validKey(by.slice(9))) {
    const expression = path("properties", by.slice(9));
    return {
      select: `dynamicType(${expression}) AS t, if(dynamicType(${expression}) = 'None', NULL, toString(${expression})) AS s`,
      by: "t, s",
      property: true,
    };
  }
  throw bad("Group by name, source, source_id, identity_kind or property:<key>");
}

export interface QueryResult {
  summary: Record<string, number | null>;
  series: { time: number; value: number | null }[];
  groups: { label: unknown; value: number | null; count: number }[];
  events: Record<string, unknown>[];
  event_names: string[];
  page: number;
  page_size: number;
  timezone: "UTC";
}

export async function runEventsQuery(reader: ClickHouse, q: EventsQuery): Promise<QueryResult> {
  validateEventsQuery(q);
  const params = new Params();
  const where = predicate(q, params);
  const value = `toNullable(toFloat64(${measure(q)}))`;
  const grouping = group(q);
  const duration = numeric(path("properties", "duration_ms"));
  const success = path("properties", "success");
  const options = {
    params: params.values,
    settings: runSettings({
      from: q.from,
      to: q.to,
      source: q.source_id ?? null,
      bucket: q.bucket,
    }),
  };
  // One at a time: each project's reader may run only a few queries at once.
  const summary = await reader.query<Record<string, number | null>>(
    `SELECT count() AS total, uniqExactIf((identity_kind, actor_id), actor_id IS NOT NULL) AS actors, uniqExactIf(actor_id, identity_kind = 'visitor') AS visitors, uniqExactIf(actor_id, identity_kind = 'installation') AS installations, uniqExactIf((actor_id, session_id), session_id IS NOT NULL AND identity_kind = 'visitor') AS sessions, avgOrNullIf(if(dynamicElement(${success}, 'Bool'), 100., 0.), dynamicType(${success}) = 'Bool') AS success_rate, avgOrNull(${duration}) AS avg_duration, quantileExactInclusiveOrNull(0.95)(${duration}) AS p95_duration, ${value} AS value, countIf(session_id IS NOT NULL AND identity_kind = 'visitor') AS session_views FROM events WHERE ${where}`,
    options,
  );
  const buckets = await reader.query<{ time: number; value: number | null }>(
    `SELECT toUnixTimestamp64Milli(bucket(event_time)) AS time, ${value} AS value FROM events WHERE ${where} GROUP BY time`,
    options,
  );
  const groups = await reader.query<{
    t: string;
    s: string | null;
    value: number | null;
    count: number;
  }>(
    `SELECT ${grouping.select}, ${value} AS value, count() AS count FROM events WHERE ${where} GROUP BY ${grouping.by} ORDER BY value DESC NULLS LAST, s LIMIT 12`,
    options,
  );
  const direction = q.order === "oldest" ? "ASC" : "DESC";
  const events = await reader.query<Record<string, unknown>>(
    `SELECT toString(source_id) AS source_id, event_id, name, source, toUnixTimestamp64Milli(event_time) AS timestamp, toUnixTimestamp64Milli(received_at) AS received_at, actor_id, identity_kind, session_id, profile_id, groups, backfill, properties FROM events WHERE ${where} ORDER BY event_time ${direction}, event_id ${direction} LIMIT ${q.page_size} OFFSET ${q.page * q.page_size}`,
    options,
  );
  const names = await reader.query<{ name: string }>(
    "SELECT DISTINCT name FROM events ORDER BY name LIMIT 100",
    {
      settings: options.settings,
    },
  );
  const measured = new Map(buckets.data.map((row) => [Number(row.time), row.value]));
  const missing = ["count", "actors", "sum"].includes(q.measure) ? 0 : null;
  return {
    summary: summary.data[0] as Record<string, number | null>,
    series: bucketGrid(q.from, q.to, q.bucket).map((time) => ({
      time,
      value: measured.has(time) ? (measured.get(time) ?? null) : missing,
    })),
    groups: groups.data.map((row) => ({
      label: grouping.property ? typedValue(row.t, row.s) : row.s,
      value: row.value,
      count: Number(row.count),
    })),
    events: events.data,
    event_names: names.data.map((row) => row.name),
    page: q.page,
    page_size: q.page_size,
    timezone: "UTC",
  };
}
