// Typed widget queries (events and logs) compiled to ClickHouse SQL over the project's scoped
// views, and measured as a total, buckets, groups or grouped buckets.
import { bad } from "../api/errors";
import type { Rules } from "../queries/custom";
import { type Bucket, RANGE_FROM, runSettings, SOURCE_SCOPE } from "../clickhouse/access";
import type { ClickHouse, QueryOptions } from "../clickhouse/client";
import { measure as eventMeasure, predicate as eventPredicate } from "../queries/events";
import { attribute, LEVELS, logConditions } from "../queries/logs";
import { bucketGrid, distinctValues, numeric, Params, path, validKey } from "../queries/properties";
import type { EventsQuery, LogsQuery } from "./spec";

export interface Window {
  from: Date;
  to: Date;
  bucket: Bucket;
}

/** The dashboard's automatic bucket for a span. */
export { bucketForSpan as autoBucket } from "../../lib/time-buckets";

export type Shape =
  | { kind: "total" }
  | { kind: "buckets" }
  | { kind: "groups"; limit: number; labels: unknown[] | null }
  | { kind: "grouped"; labels: unknown[] };

export interface Point {
  time: number;
  value: number | null;
}

export interface GroupValue {
  label: unknown;
  value: number | null;
}

export interface Measured {
  total: number | null;
  points: Point[];
  groups: GroupValue[];
  grouped: [unknown, Point[]][];
}

export const emptyMeasured = (): Measured => ({ total: null, points: [], groups: [], grouped: [] });

/** Measures that count, so an absent bucket or group is 0 rather than a gap. */
export const COUNTING = [
  "count",
  "actors",
  "sessions",
  "new_actors",
  "returning_actors",
  "unique",
  "sum",
];
export const missingIsZero = (measure: string) => COUNTING.includes(measure);

/**
 * Stands for the start of the period a new or returning actor is judged against: the range's
 * start for a total or a group, and each row's bucket for a time series.
 */
const PERIOD_START = "__highkey_period_start__";
const atWindow = (measure: string) => measure.replaceAll(PERIOD_START, RANGE_FROM);
const atBucket = (measure: string, time: string) =>
  measure.replaceAll(PERIOD_START, `bucket(${time})`);

/** The range's events, each with its actor's first matching event in all retained history. */
function withFirstSeen(where: string): string {
  const firsts = `SELECT ifNull(identity_kind, '') AS kind, actor_id AS actor, min(event_time) AS first_seen FROM all_events WHERE actor_id IS NOT NULL AND ${SOURCE_SCOPE} AND ${where} GROUP BY kind, actor`;
  return `(SELECT event_time, name, source, source_id, identity_kind, actor_id, session_id, properties, f.first_seen AS first_seen FROM events INNER JOIN (${firsts}) AS f ON ifNull(identity_kind, '') = f.kind AND actor_id = f.actor)`;
}

/** A label expression that yields the group's value as JSON text, as `JSON.stringify` writes it. */
function jsonLabel(expression: string, dynamic: boolean): string {
  if (!dynamic) return `if(isNull(${expression}), 'null', toJSONString(toString(${expression})))`;
  const as = (type: string) => `dynamicElement(${expression}, '${type}')`;
  return `multiIf(dynamicType(${expression}) = 'String', toJSONString(${as("String")}), dynamicType(${expression}) IN ('Int64', 'UInt64', 'Float64'), toString(${numeric(expression)}), dynamicType(${expression}) = 'Bool', if(${as("Bool")}, 'true', 'false'), dynamicType(${expression}) = 'None', 'null', toJSONString(${expression}))`;
}

interface Compiled {
  /** A scoped view, or a subquery over one. */
  table: string;
  time: string;
  measure: string;
  where: string;
  label: string;
  missingZero: boolean;
  params: Params;
}

const ACTOR = "(identity_kind, actor_id)";

function compileEvents(q: EventsQuery, rules?: Rules): Compiled {
  if (!["count", "actors", "sessions", "new_actors", "returning_actors"].includes(q.measure)) {
    if (!q.property) throw bad("This measure needs a property");
    path("properties", q.property);
  }
  const params = new Params();
  const where = eventPredicate(
    {
      event: q.event,
      source: null,
      identity_kind: q.identity_kind,
      filters: q.filters ?? [],
    } as Parameters<typeof eventPredicate>[0],
    params,
    rules,
  );
  const by = q.group_by ?? "name";
  let label: string;
  if (["name", "source", "source_id", "identity_kind"].includes(by)) label = jsonLabel(by, false);
  else if (by.startsWith("property:") && validKey(by.slice(9)))
    label = jsonLabel(path("properties", by.slice(9)), true);
  else throw bad("Group by name, source, source_id, identity_kind or property:<key>");
  if (q.measure === "new_actors" || q.measure === "returning_actors") {
    const compare = q.measure === "new_actors" ? ">=" : "<";
    return {
      table: withFirstSeen(where),
      time: "event_time",
      measure: `uniqExactIf(${ACTOR}, actor_id IS NOT NULL AND first_seen ${compare} ${PERIOD_START})`,
      where,
      label,
      missingZero: true,
      params,
    };
  }
  return {
    table: "events",
    time: "event_time",
    measure: eventMeasure(q),
    where,
    label,
    missingZero: missingIsZero(q.measure),
    params,
  };
}

function compileLogs(q: LogsQuery): Compiled {
  const params = new Params();
  let measure = "count()";
  if (q.measure !== "count") {
    if (!q.attribute) throw bad("This measure needs an attribute");
    const value = attribute(q.attribute, params);
    const quantiles: Record<string, number> = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99 };
    const level = quantiles[q.measure];
    measure =
      q.measure === "unique"
        ? distinctValues(value)
        : level !== undefined
          ? `quantileExactInclusiveOrNull(${level})(${numeric(value)})`
          : `${q.measure}OrNull(${numeric(value)})`;
  }
  if (q.min_level && !LEVELS.includes(q.min_level as (typeof LEVELS)[number]))
    throw bad("Invalid log level");
  const conditions = logConditions(
    {
      level: q.level,
      min_level: q.min_level,
      service: q.service,
      environment: q.environment,
      trace_id: null,
      search: q.search,
      filters: (q.filters ?? []) as never,
    },
    params,
  );
  const by = q.group_by ?? "service";
  let label: string;
  if (by === "service" || by === "environment") label = jsonLabel(by, false);
  else if (by === "level") label = jsonLabel("toString(level)", false);
  else if (by.startsWith("attribute:") && by.length > 10)
    label = jsonLabel(attribute(by.slice(10), params), true);
  else throw bad("Group by service, level, environment or attribute:<key>");
  return {
    table: "logs",
    time: "timestamp",
    measure,
    where: conditions.length ? conditions.join(" AND ") : "1",
    label,
    missingZero: missingIsZero(q.measure),
    params,
  };
}

export interface RunOptions {
  rules?: Rules;
  reader: ClickHouse;
  source: string | null;
  signal?: AbortSignal;
  settings?: Record<string, string | number>;
}

/** A query's parameters, deadline and settings: the window, the source and the run's own. */
export function scoped(
  w: Window,
  source: string | null,
  run: RunOptions,
  params: Record<string, unknown>,
): QueryOptions {
  return {
    params: params as QueryOptions["params"],
    signal: run.signal,
    settings: {
      ...runSettings({ from: w.from, to: w.to, source, bucket: w.bucket }),
      ...(run.settings ?? {}),
    },
  };
}

function options(
  c: Compiled,
  w: Window,
  source: string | null,
  run: RunOptions,
  params = c.params.values,
): QueryOptions {
  return scoped(w, source, run, params);
}

async function buckets(
  c: Compiled,
  w: Window,
  source: string | null,
  run: RunOptions,
  where: string,
  params: Record<string, unknown>,
): Promise<Point[]> {
  const value = `toNullable(toFloat64(${atBucket(c.measure, c.time)}))`;
  const rows = await run.reader.query<{ time: number; value: number | null }>(
    `SELECT toUnixTimestamp64Milli(bucket(${c.time})) AS time, ${value} AS value FROM ${c.table} WHERE ${where} GROUP BY time`,
    options(c, w, source, run, params as never),
  );
  const measured = new Map(rows.data.map((row) => [Number(row.time), row.value]));
  const missing = c.missingZero ? 0 : null;
  return bucketGrid(w.from, w.to, w.bucket).map((time) => ({
    time,
    value: measured.has(time) ? (measured.get(time) ?? null) : missing,
  }));
}

/** Measures one typed query over `w` in the given shape. */
export async function measure(
  q: EventsQuery | LogsQuery,
  w: Window,
  shape: Shape,
  run: RunOptions,
): Promise<Measured> {
  const c = q.signal === "events" ? compileEvents(q, run.rules) : compileLogs(q);
  const source = q.source_id ?? run.source;
  const value = `toNullable(toFloat64(${atWindow(c.measure)}))`;
  const total = await run.reader.query<{ value: number | null }>(
    `SELECT ${value} AS value FROM ${c.table} WHERE ${c.where}`,
    options(c, w, source, run),
  );
  const out: Measured = { ...emptyMeasured(), total: total.data[0]?.value ?? null };
  if (shape.kind === "buckets")
    out.points = await buckets(c, w, source, run, c.where, c.params.values);
  else if (shape.kind === "groups") {
    let where = c.where;
    const params: Record<string, unknown> = { ...c.params.values };
    if (shape.labels) {
      if (shape.labels.length === 0) return out;
      params.labels = shape.labels.map((label) => JSON.stringify(label));
      where += ` AND ${c.label} IN {labels:Array(String)}`;
    }
    const rows = await run.reader.query<{ label: string; value: number | null }>(
      `SELECT ${c.label} AS label, ${value} AS value FROM ${c.table} WHERE ${where} GROUP BY label ORDER BY value DESC NULLS LAST, label LIMIT ${shape.limit}`,
      options(c, w, source, run, params as never),
    );
    out.groups = rows.data.map((row) => ({ label: JSON.parse(row.label), value: row.value }));
  } else if (shape.kind === "grouped") {
    for (const label of shape.labels) {
      const params = { ...c.params.values, label: JSON.stringify(label) };
      out.grouped.push([
        label,
        await buckets(c, w, source, run, `${c.where} AND ${c.label} = {label:String}`, params),
      ]);
    }
  }
  return out;
}

/** Event or log rows for a list view, newest first. */
export async function rows(
  q: EventsQuery | LogsQuery,
  w: Window,
  limit: number,
  run: RunOptions,
): Promise<Record<string, unknown>[]> {
  const c = q.signal === "events" ? compileEvents(q, run.rules) : compileLogs(q);
  const source = q.source_id ?? run.source;
  const sql =
    q.signal === "events"
      ? `SELECT toString(source_id) AS source_id, event_id, name, source, toUnixTimestamp64Milli(event_time) AS timestamp, toUnixTimestamp64Milli(received_at) AS received_at, actor_id, identity_kind, session_id, properties FROM events WHERE ${c.where} ORDER BY event_time DESC, event_id DESC LIMIT ${limit}`
      : `SELECT log_id, toString(source_id) AS source_id, toUnixTimestamp64Milli(timestamp) AS timestamp, toUnixTimestamp64Milli(received_at) AS received_at, toString(level) AS level, message, service, environment, trace_id, span_id, request_id, attributes FROM (SELECT * FROM logs WHERE ${c.where} ORDER BY timestamp DESC, log_id DESC LIMIT ${limit}) ORDER BY timestamp DESC, log_id DESC`;
  return (await run.reader.query<Record<string, unknown>>(sql, options(c, w, source, run))).data;
}
