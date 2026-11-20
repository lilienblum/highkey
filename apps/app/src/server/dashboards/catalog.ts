// What a project holds, in a form a dashboard author (or an agent) can build widgets from:
// event names and property keys, log facets, sources, retention and the document limits.
// Every scan is bounded, so the catalog stays cheap on large projects.
import type { ApiContext } from "../api/context";
import { runSettings } from "../clickhouse/access";
import type { ClickHouse } from "../clickhouse/client";
import { logRetention } from "../db/keys";
import { revenueSettings } from "../db/revenue";
import { resolveProduct } from "../db/products";
import { listSources } from "../db/sources";
import { facets, LEVELS } from "../queries/logs";
import { readAs } from "../queries/read";
import type { Document, Filter, QuerySpec, Widget } from "./spec";
import { nearest } from "./suggest";
import { type Issue, limitsJson, type Report } from "./validate";

const MAX_KEYS = 100;
const SAMPLE_EVENTS = 1_000;
const LOG_DAYS = 31;
const DAY = 86_400_000;

const SCALARS: Record<string, string> = {
  String: "string",
  Int64: "number",
  UInt64: "number",
  Float64: "number",
  Bool: "boolean",
};

function spelling(name: string, known: Iterable<string>, hint: string): string {
  const close = nearest(name, known);
  return close ? `did you mean \`${close}\`? ${hint}` : hint;
}

/** The warning for an event name that has no events behind it. */
export function unknownEvent(path: string, name: string, known: Iterable<string>): Issue {
  return {
    path,
    message: `No events named "${name}" have been received for this project`,
    hint: spelling(
      name,
      known,
      "Check the spelling against the catalog's events.names; the widget runs and stays empty until such events arrive",
    ),
  };
}

/** The event names a query reads, each with its path inside the query and its filters. */
export function namedEvents(q: QuerySpec): { path: string; event: string; filters: Filter[] }[] {
  if (q.signal === "events")
    return q.event ? [{ path: "/event", event: q.event, filters: q.filters ?? [] }] : [];
  if (q.signal === "funnel")
    return q.steps.map((step, i) => ({
      path: `/steps/${i}/event`,
      event: step.event,
      filters: step.filters ?? [],
    }));
  if (q.signal === "retention")
    return [
      { path: "/start/event", event: q.start.event, filters: q.start.filters ?? [] },
      { path: "/return/event", event: q.return.event, filters: q.return.filters ?? [] },
    ];
  return [];
}

/** Warnings for named events with no events at all: one LIMIT 1 probe per distinct name. */
export async function unknownEvents(
  reader: ClickHouse,
  widget: Widget,
  settings: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<Issue[]> {
  const named = Object.entries(widget.queries).flatMap(([id, q]) =>
    namedEvents(q).map((n) => [`${id}${n.path}`, n.event] as const),
  );
  const missing = new Map<string, boolean>();
  const issues: Issue[] = [];
  let known: string[] | null = null;
  for (const [at, name] of named) {
    if (!missing.has(name)) {
      const found = await reader.query(
        "SELECT 1 FROM all_events WHERE name = {name:String} LIMIT 1",
        { params: { name }, settings, signal },
      );
      missing.set(name, found.rows === 0);
    }
    if (!missing.get(name)) continue;
    known ??= (
      await reader.query<{ name: string }>(
        "SELECT DISTINCT name FROM all_events ORDER BY name LIMIT 100",
        { settings, signal },
      )
    ).data.map((r) => r.name);
    issues.push(unknownEvent(`/queries/${at}`, name, known));
  }
  return issues;
}

export async function catalog(ctx: ApiContext, project: string) {
  const product = await resolveProduct(ctx.db, project);
  const sources = await listSources(ctx.db, product.id);
  const logsDays = await logRetention(ctx.db, product.id);
  const revenue = await revenueSettings(ctx.db, product.id);
  const now = Date.now();
  return readAs(ctx, product.id, async (reader) => {
    const cutoff = now - product.retention_days * DAY;
    const names = await reader.query<{ name: string }>(
      `SELECT DISTINCT name FROM all_events WHERE event_time >= fromUnixTimestamp64Milli({cutoff:Int64}, 'UTC') ORDER BY name LIMIT ${MAX_KEYS}`,
      { params: { cutoff } },
    );
    const paths = await reader.query<{ path: string; type: string; count: number }>(
      `SELECT pt.1 AS path, pt.2 AS type, count() AS count FROM (SELECT arrayJoin(JSONAllPathsWithTypes(properties)) AS pt FROM (SELECT properties FROM all_events WHERE event_time >= fromUnixTimestamp64Milli({cutoff:Int64}, 'UTC') ORDER BY event_time DESC LIMIT ${SAMPLE_EVENTS})) GROUP BY path, type`,
      { params: { cutoff } },
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
    const properties = [...keys.entries()]
      .filter(([, e]) => e.type)
      .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_KEYS)
      .map(([key, e]) => ({ key, type: e.type, count: e.count }));
    const settings = runSettings({
      from: new Date(now - LOG_DAYS * DAY),
      to: new Date(now + 60_000),
      source: null,
      bucket: "day",
    });
    const logFacets = await facets(reader, settings);
    const present = new Set(
      (
        await reader.query<{ level: string }>(
          "SELECT DISTINCT toString(level) AS level FROM logs",
          { settings },
        )
      ).data.map((r) => r.level),
    );
    return {
      project: { id: product.id, slug: product.slug, name: product.name },
      events: { names: names.data.map((r) => r.name), properties },
      logs: { ...logFacets, levels: LEVELS.filter((l) => present.has(l)) },
      sources: sources.map((s) => ({ id: s.id, name: s.name })),
      retention: { events_days: product.retention_days, logs_days: logsDays },
      revenue: { ...revenue, property: "revenue", unit: "integer_cents" },
      limits: limitsJson(),
    };
  });
}

type Catalog = Awaited<ReturnType<typeof catalog>>;

/** Warnings, never errors, for event names and property keys the catalog does not list. */
export function warnUnknown(widget: Widget, base: string, found: Catalog, report: Report): void {
  const names = new Set(found.events.names);
  const properties = new Set(found.events.properties.map((p) => p.key));
  const property = (path: string, key: string) => {
    if (properties.size < MAX_KEYS && !properties.has(key))
      report.warnings.push({
        path,
        message: `No recent events carry a property "${key}"`,
        hint: spelling(
          key,
          properties,
          "Check the spelling against the catalog's events.properties (newest 1,000 events)",
        ),
      });
  };
  for (const [id, q] of Object.entries(widget.queries)) {
    const at = `${base}/queries/${id}`;
    for (const named of namedEvents(q)) {
      if (names.size < MAX_KEYS && !names.has(named.event))
        report.warnings.push(unknownEvent(`${at}${named.path}`, named.event, names));
      const filters = named.path.replace(/\/event$/, "/filters");
      for (const [i, f] of named.filters.entries())
        property(`${at}${filters}/${i}/property`, f.property);
    }
    if (q.signal !== "events") continue;
    if (q.property) property(`${at}/property`, q.property);
    if (q.group_by?.startsWith("property:")) property(`${at}/group_by`, q.group_by.slice(9));
    if (!q.event)
      for (const [i, f] of (q.filters ?? []).entries())
        property(`${at}/filters/${i}/property`, f.property);
  }
}

export function warnUnknownDocument(doc: Document, found: Catalog, report: Report): void {
  for (const [i, w] of doc.widgets.entries()) warnUnknown(w, `/widgets/${i}`, found, report);
}
