// Widget runs: the effective window, series built from measured queries, and `runWidget`, which
// measures them under the widget's deadline. Ported from the Rust API's dashboards/run.rs.
import { fields } from "../api/body";
import type { ApiContext } from "../api/context";
import { ApiError, bad } from "../api/errors";
import type { Bucket } from "../clickhouse/access";
import { ClickHouseError } from "../clickhouse/client";
import { resolveProduct } from "../db/products";
import { getSource } from "../db/sources";
import { readAs } from "../queries/read";
import { unknownEvents } from "./catalog";
import { detailed, invalid, timedOut } from "./errors";
import { evaluate as evaluateFormula, parseFormula } from "./formula";
import {
  autoBucket,
  emptyMeasured,
  type GroupValue,
  type Measured,
  measure,
  type Point,
  type RunOptions,
  rows,
  type Shape,
  type Window,
} from "./metrics";
import {
  type Color,
  effectiveCompare,
  type QuerySpec,
  readsLogs,
  seriesOrDefault,
  type Widget,
} from "./spec";
import { checkWidget, type Issue, Limits, parseWidget, Report, rangeHours } from "./validate";

const DAY = 86_400_000;
const LOG_RANGE_DAYS = 31;
const EVENT_RANGE_DAYS = 366;
const HOURLY_RANGE_DAYS = 31;
const GROUPED_SERIES = 6;
const DEFAULT_RANKING_LIMIT = 10;
const LIST_ROWS = 50;
const CYCLE: Color[] = ["yellow", "violet", "aqua"];
const BUCKETS = ["auto", "hour", "day", "week", "month"];

export interface EffectiveWindow {
  window: Window;
  requested: { from: Date; to: Date };
  clamped: boolean;
  warnings: Issue[];
}

/** The widget's range override, clamped to what every query allows, with a permitted bucket. */
export function effectiveWindow(
  widget: Widget,
  fromIn: Date,
  to: Date,
  bucket?: string | null,
): EffectiveWindow {
  let from = fromIn;
  const hours = widget.range != null ? rangeHours(widget.range) : null;
  if (hours !== null) from = new Date(to.getTime() - hours * 3_600_000);
  const requested = { from, to };
  const warnings: Issue[] = [];
  const days = Object.values(widget.queries).some(readsLogs) ? LOG_RANGE_DAYS : EVENT_RANGE_DAYS;
  const clamped = to.getTime() - from.getTime() > days * DAY;
  if (clamped) {
    from = new Date(to.getTime() - days * DAY);
    warnings.push({
      path: "/range",
      message: `Newest ${days} days`,
      hint: "The range is longer than this widget's queries allow, so it shows the newest window.",
    });
  }
  const span = to.getTime() - from.getTime();
  const auto = autoBucket(span);
  const explicit = [widget.view.bucket, bucket].find((b) => b != null && b !== "auto") ?? null;
  let chosen: Bucket = auto;
  if (explicit === "hour" && span > HOURLY_RANGE_DAYS * DAY)
    warnings.push({
      path: "/view/bucket",
      message: `Bucket hour is not allowed for this range; using ${auto}`,
      hint: null,
    });
  else if (explicit && ["hour", "day", "week", "month"].includes(explicit))
    chosen = explicit as Bucket;
  return { window: { from, to, bucket: chosen }, requested, clamped, warnings };
}

export function previousWindow(w: Window): Window {
  const span = w.to.getTime() - w.from.getTime();
  return { from: new Date(w.from.getTime() - span), to: w.from, bucket: w.bucket };
}

export interface SeriesResult {
  label: string;
  color: Color;
  group?: unknown;
  total: number | null;
  previous_total: number | null;
  points?: Point[];
  previous_points?: Point[];
  groups?: GroupValue[];
}

function groupBy(q: QuerySpec | undefined): string | null {
  return q && (q.signal === "events" || q.signal === "logs") ? (q.group_by ?? null) : null;
}

function groupedTimeSeries(w: Widget): boolean {
  return (
    groupBy(Object.values(w.queries)[0]) !== null && ["line", "area", "bar"].includes(w.view.type)
  );
}

export function shapeFor(w: Widget): Shape {
  if (groupedTimeSeries(w)) return { kind: "grouped", labels: [] };
  if (w.view.type === "ranking")
    return { kind: "groups", limit: w.view.limit ?? DEFAULT_RANKING_LIMIT, labels: null };
  if (
    ["line", "area", "bar"].includes(w.view.type) ||
    (w.view.type === "stat" && w.view.sparkline === true)
  )
    return { kind: "buckets" };
  return { kind: "total" };
}

function fillsZero(q: QuerySpec): boolean {
  if (q.signal === "events" || q.signal === "logs")
    return ["count", "actors", "sum"].includes(q.measure);
  return false;
}

const labelText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Turns per-query measurements into series. An absent bucket or group is zero for count, actors and sum, else a gap. */
export function evaluate(
  widget: Widget,
  current: Map<string, Measured>,
  previous: Map<string, Measured> | null,
): SeriesResult[] {
  const zero = new Map(Object.entries(widget.queries).map(([id, q]) => [id, fillsZero(q)]));
  const fill = (id: string, value: number | null | undefined): number | null =>
    value != null ? value : zero.get(id) ? 0 : null;
  const known = Object.keys(widget.queries);
  const first = current.get(known[0] as string);
  const grouped = groupedTimeSeries(widget);
  const limit = widget.view.limit ?? DEFAULT_RANKING_LIMIT;
  const overTime = (
    expr: ReturnType<typeof parseFormula> & { ok: true },
    series: [string, Point[]][],
  ) => {
    const index = series.map(([id, points]) => {
      const at = new Map<number, number | null>();
      for (const p of points) if (!at.has(p.time)) at.set(p.time, p.value);
      return [id, at] as const;
    });
    const times = [...new Set(index.flatMap(([, at]) => [...at.keys()]))].sort((a, b) => a - b);
    return times.map((time) => ({
      time,
      value: evaluateFormula(expr.expr, (id) => {
        const found = index.find(([q]) => q === id);
        return found ? fill(id, found[1].get(time)) : null;
      }),
    }));
  };
  const out: SeriesResult[] = [];
  seriesOrDefault(widget).forEach((series, index) => {
    const expr = parseFormula(series.expr, known);
    if (!expr.ok) return;
    const label = series.label ?? series.expr;
    const color = series.color ?? (CYCLE[index % CYCLE.length] as Color);
    const totals = (set: Map<string, Measured>) =>
      evaluateFormula(expr.expr, (id) => (set.has(id) ? fill(id, set.get(id)?.total) : null));
    if (grouped) {
      const labels = (first?.grouped ?? []).map(([l]) => l).slice(0, GROUPED_SERIES);
      labels.forEach((group, i) => {
        out.push({
          label: labelText(group),
          color: CYCLE[i % CYCLE.length] as Color,
          group,
          total: null,
          previous_total: null,
          points: overTime(
            expr,
            [...current.entries()].map(([id, m]) => [
              id,
              m.grouped.find(([l]) => same(l, group))?.[1] ?? [],
            ]),
          ),
        });
      });
      return;
    }
    const result: SeriesResult = {
      label,
      color,
      total: totals(current),
      previous_total: previous ? totals(previous) : null,
    };
    if (widget.view.type === "ranking") {
      result.groups = (first?.groups ?? []).slice(0, limit).map((row) => ({
        label: row.label,
        value: evaluateFormula(expr.expr, (id) =>
          current.has(id)
            ? fill(id, current.get(id)?.groups.find((g) => same(g.label, row.label))?.value)
            : null,
        ),
      }));
    } else if ([...current.values()].some((m) => m.points.length > 0)) {
      result.points = overTime(
        expr,
        [...current.entries()].map(([id, m]) => [id, m.points]),
      );
      if (previous && [...previous.values()].some((m) => m.points.length > 0))
        result.previous_points = overTime(
          expr,
          [...previous.entries()].map(([id, m]) => [id, m.points]),
        );
    }
    out.push(result);
  });
  return out;
}

/** Every query over `w`. The first query picks the groups the others are measured for. */
async function measureAll(
  widget: Widget,
  w: Window,
  shape: Shape,
  run: RunOptions,
): Promise<Map<string, Measured>> {
  const entries = Object.entries(widget.queries);
  const out = new Map<string, Measured>();
  const [firstEntry, ...rest] = entries;
  if (!firstEntry) return out;
  const [firstId, first] = firstEntry;
  const typed = (q: QuerySpec) => {
    if (q.signal !== "events" && q.signal !== "logs") throw bad("This query kind cannot run yet");
    return q;
  };
  let others: Shape;
  if (shape.kind === "grouped") {
    const top = await measure(
      typed(first),
      w,
      { kind: "groups", limit: GROUPED_SERIES, labels: null },
      run,
    );
    const measured = await measure(
      typed(first),
      w,
      { kind: "grouped", labels: top.groups.map((g) => g.label) },
      run,
    );
    out.set(firstId, measured);
    others = { kind: "grouped", labels: measured.grouped.map(([l]) => l) };
  } else {
    const measured = await measure(typed(first), w, shape, run);
    out.set(firstId, measured);
    others =
      shape.kind === "groups" && shape.labels === null
        ? { kind: "groups", limit: shape.limit, labels: measured.groups.map((g) => g.label) }
        : shape;
  }
  for (const [id, q] of rest) out.set(id, await measure(typed(q), w, others, run));
  return out;
}

const unknownSource = () =>
  detailed(404, "Source not found", "not_found", [
    {
      path: "/source_id",
      message: "No source of this project has that id",
      hint: "Use a source id from the project's sources (describe_project or the catalog lists them), or omit source_id for all sources",
    },
  ]);

export interface RunRequest {
  widget: unknown;
  from: string;
  to: string;
  bucket?: string | null;
  source_id?: string | null;
}

export function parseRunRequest(body: unknown): RunRequest {
  return fields(body, {
    widget: "unknown",
    from: "string",
    to: "string",
    bucket: "string?",
    source_id: "string?",
  }) as RunRequest;
}

function time(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw bad(`${name} must be an RFC 3339 time`);
  return parsed;
}

/** Validates and runs one widget for a project (id or slug); `timeout_ms` counts from the start, waiting included. */
export async function runWidget(ctx: ApiContext, project: string, request: RunRequest) {
  const started = Date.now();
  const parsed = parseWidget(request.widget);
  if (!parsed.ok) throw invalid(parsed.report);
  const widget = parsed.value;
  const report = new Report();
  checkWidget(widget, "", report);
  if (!report.ok) throw invalid(report);
  const from = time(request.from, "from");
  const to = time(request.to, "to");
  if (to <= from) throw bad("`to` must be after `from`");
  if (request.bucket != null && !BUCKETS.includes(request.bucket))
    throw bad("bucket must be auto, hour, day, week or month");
  const timeoutMs = widget.timeout_ms ?? Limits.DEFAULT_TIMEOUT_MS;
  const deadline = started + timeoutMs;
  const product = resolveProduct(ctx.store, project).id;
  if (request.source_id) {
    try {
      getSource(ctx.store, product, request.source_id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw unknownSource();
      throw error;
    }
  }
  const effective = effectiveWindow(widget, from, to, request.bucket);
  const queries = Object.values(widget.queries);
  const events = queries.some((q) => !readsLogs(q));
  const logs = queries.some(readsLogs);
  let series: SeriesResult[] = [];
  let listRows: Record<string, unknown>[] | null = null;
  const ran: Issue[] = [];
  if (events || logs) {
    const releases: (() => void)[] = [];
    try {
      for (const gate of [logs ? ctx.gates.logs : null, events ? ctx.gates.events : null]) {
        if (!gate) continue;
        const release = await gate.acquire(deadline);
        if (!release) throw timedOut(timeoutMs);
        releases.push(release);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw timedOut(timeoutMs);
      const signal = AbortSignal.timeout(left);
      const settings = { max_execution_time: Math.min(10, Math.max(1, Math.ceil(left / 1000))) };
      await readAs(ctx, product, async (reader) => {
        const run: RunOptions = { reader, source: request.source_id ?? null, signal, settings };
        ran.push(...(await unknownEvents(reader, widget, settings, signal)));
        if (widget.view.type === "events" || widget.view.type === "logs") {
          const first = queries[0];
          if (first && (first.signal === "events" || first.signal === "logs"))
            listRows = await rows(first, effective.window, LIST_ROWS, run);
        } else {
          const shape = shapeFor(widget);
          const grouped = shape.kind === "grouped";
          const compare = effectiveCompare(widget.view) === "previous_period" && !grouped;
          const previousShape: Shape | null = compare
            ? shape.kind === "buckets"
              ? { kind: "buckets" }
              : { kind: "total" }
            : null;
          const current = await measureAll(widget, effective.window, shape, run);
          const before = previousShape
            ? await measureAll(widget, previousWindow(effective.window), previousShape, run)
            : null;
          series = evaluate(widget, current, before);
        }
      });
    } catch (error) {
      // The deadline, whether ClickHouse or the request's own timer noticed it first.
      const timeout =
        (error instanceof ClickHouseError && error.code === 159) ||
        (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
      if (timeout) throw timedOut(timeoutMs);
      throw error;
    } finally {
      for (const release of releases) release();
    }
  }
  const warnings = [...effective.warnings];
  for (const issue of [...ran, ...report.warnings])
    if (!warnings.some((w) => w.path === issue.path)) warnings.push(issue);
  return {
    widget: widget.id,
    range: {
      from: effective.window.from.toISOString(),
      to: effective.window.to.toISOString(),
      bucket: effective.window.bucket,
      clamped: effective.clamped,
      requested_from: effective.requested.from.toISOString(),
      requested_to: effective.requested.to.toISOString(),
    },
    series,
    rows: listRows,
    columns: null,
    elapsed_ms: Date.now() - started,
    warnings,
  };
}

export { emptyMeasured };
