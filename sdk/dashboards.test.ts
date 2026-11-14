import { expect, test } from "bun:test";
import {
  blankDocument,
  duplicateWidget,
  formatMeasure,
  hasSeriesLabel,
  lowerIsBetter,
  moveWidget,
  overviewTemplate,
  queryLabel,
  cellKind,
  formatCell,
  tableColumns,
  tableNotes,
  validTime,
  parseJsonCell,
  TABLE_ROW_LIMIT,
  removeWidget,
  resolvedSize,
  responsiveWidth,
  seriesDisplayLabel,
  seriesStyle,
  SIZE_PRESETS,
  thresholdColor,
  uniqueWidgetId,
  upsertWidget,
  type Widget,
} from "../apps/dashboard/src/lib/dashboards";

const ids = (doc: { widgets: Widget[] }) => doc.widgets.map((w) => w.id);

test("responsiveWidth follows the spec table", () => {
  expect(responsiveWidth(3, "wide")).toBe(3);
  expect(responsiveWidth(8, "wide")).toBe(8);
  expect(responsiveWidth(3, "medium")).toBe(6);
  expect(responsiveWidth(4, "medium")).toBe(6);
  expect(responsiveWidth(6, "medium")).toBe(6);
  expect(responsiveWidth(8, "medium")).toBe(12);
  expect(responsiveWidth(12, "medium")).toBe(12);
  expect(responsiveWidth(3, "narrow")).toBe(12);
  expect(responsiveWidth(4, "narrow")).toBe(12);
  expect(responsiveWidth(6, "narrow")).toBe(12);
});

test("size presets and defaults match the spec", () => {
  expect(SIZE_PRESETS.map((p) => [p.label, p.size.w, p.size.h])).toEqual([
    ["Small", 3, 1],
    ["Medium", 6, 2],
    ["Large", 8, 2],
    ["Wide", 12, 2],
    ["Tall", 12, 3],
  ]);
  const widget = (type: string, size?: { w: number; h: number }) =>
    ({ id: "w", title: "W", view: { type }, size, queries: {} }) as unknown as Widget;
  expect(resolvedSize(widget("stat"))).toEqual({ w: 3, h: 1 });
  expect(resolvedSize(widget("line"))).toEqual({ w: 6, h: 2 });
  expect(resolvedSize(widget("area"))).toEqual({ w: 6, h: 2 });
  expect(resolvedSize(widget("bar"))).toEqual({ w: 6, h: 2 });
  expect(resolvedSize(widget("ranking"))).toEqual({ w: 6, h: 2 });
  expect(resolvedSize(widget("events"))).toEqual({ w: 12, h: 3 });
  expect(resolvedSize(widget("logs"))).toEqual({ w: 12, h: 3 });
  expect(resolvedSize(widget("text"))).toEqual({ w: 4, h: 1 });
  expect(resolvedSize(widget("stat", { w: 8, h: 3 }))).toEqual({ w: 8, h: 3 });
});

test("seriesStyle cycles hues and switches to dither after three", () => {
  expect([0, 1, 2, 3, 4, 5].map(seriesStyle)).toEqual([
    { color: "yellow", dither: false },
    { color: "violet", dither: false },
    { color: "aqua", dither: false },
    { color: "yellow", dither: true },
    { color: "violet", dither: true },
    { color: "aqua", dither: true },
  ]);
});

test("thresholdColor picks the last step reached and keeps fallback below the first", () => {
  const steps = [
    { at: 0, color: "red" as const },
    { at: 95, color: "yellow" as const },
    { at: 99, color: "green" as const },
  ];
  expect(thresholdColor(94.9, steps, "aqua")).toBe("red");
  expect(thresholdColor(95, steps, "aqua")).toBe("yellow");
  expect(thresholdColor(99, steps, "aqua")).toBe("green");
  expect(thresholdColor(-1, steps, "aqua")).toBe("aqua");
  expect(thresholdColor(null, steps, "aqua")).toBe("aqua");
  expect(thresholdColor(50, [], "violet")).toBe("violet");
});

test("formatMeasure handles null, ratio, percent, prefix/suffix and decimals", () => {
  expect(formatMeasure(null, {})).toBe("—");
  expect(formatMeasure(null, { unit: "percent" })).toBe("—");
  expect(formatMeasure(1234, {})).toBe("1,234");
  expect(formatMeasure(1234.5678, { decimals: 1 })).toBe("1,234.6");
  expect(formatMeasure(2, { decimals: 2 })).toBe("2.00");
  expect(formatMeasure(0.987, { unit: "ratio" })).toBe("98.7%");
  expect(formatMeasure(0.5, { unit: "ratio", decimals: 0 })).toBe("50%");
  expect(formatMeasure(12.34, { unit: "percent", decimals: 1 })).toBe("12.3%");
  expect(formatMeasure(42, { prefix: "$", decimals: 2 })).toBe("$42.00");
  expect(formatMeasure(42, { suffix: " req" })).toBe("42 req");
  expect(formatMeasure(250, { unit: "ms" })).toBe("250 ms");
  expect(formatMeasure(1.5, { unit: "seconds" })).toBe("1.5 s");
  expect(formatMeasure(512, { unit: "bytes" })).toBe("512 B");
  expect(formatMeasure(1536, { unit: "bytes" })).toBe("1.5 KiB");
  expect(formatMeasure(5 * 1024 * 1024, { unit: "bytes" })).toBe("5 MiB");
});

test("overviewTemplate is a valid shape with unique ids and no orange", () => {
  const doc = overviewTemplate("Mine");
  expect(doc.version).toBe(1);
  expect(doc.name).toBe("Mine");
  expect(ids(doc)).toEqual([
    "events",
    "activity",
    "breakdown",
    "sources",
    "actors",
    "success",
    "duration",
  ]);
  expect(new Set(ids(doc)).size).toBe(7);
  for (const widget of doc.widgets) {
    expect(widget.id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(widget.title.length).toBeGreaterThan(0);
    expect(widget.title.length).toBeLessThanOrEqual(80);
    expect(Object.keys(widget.queries).length).toBeGreaterThan(0);
    for (const id of Object.keys(widget.queries)) expect(id).toMatch(/^[a-z][a-z0-9_]{0,15}$/);
  }
  expect(JSON.stringify(doc)).not.toContain("orange");
  expect(blankDocument("Empty")).toEqual({ version: 1, name: "Empty", widgets: [] });
});

test("moveWidget, duplicateWidget and uniqueWidgetId keep ids unique", () => {
  const doc = overviewTemplate("D");
  expect(ids(moveWidget(doc, "events", 2)).slice(0, 3)).toEqual([
    "activity",
    "breakdown",
    "events",
  ]);
  expect(ids(moveWidget(doc, "events", -1))).toEqual(ids(doc));
  expect(ids(moveWidget(doc, "duration", 5))).toEqual(ids(doc));
  expect(ids(doc)[0]).toBe("events");

  const copy = duplicateWidget(doc, "events");
  expect(ids(copy).slice(0, 3)).toEqual(["events", "events-2", "activity"]);
  const again = duplicateWidget(copy, "events");
  expect(ids(again).slice(0, 3)).toEqual(["events", "events-3", "events-2"]);
  expect(new Set(ids(again)).size).toBe(ids(again).length);

  expect(uniqueWidgetId(doc, "fresh")).toBe("fresh");
  expect(uniqueWidgetId(doc, "events")).toBe("events-2");
  expect(uniqueWidgetId(doc, "Hello World!")).toBe("hello-world");
  expect(uniqueWidgetId(doc, "")).toBe("widget");
  const long = "a".repeat(40);
  const longDoc = upsertWidget(blankDocument("L"), { ...doc.widgets[0], id: long });
  const next = uniqueWidgetId(longDoc, long);
  expect(next.length).toBeLessThanOrEqual(40);
  expect(next).not.toBe(long);
});

test("upsertWidget replaces by id or appends, removeWidget drops, and inputs are not mutated", () => {
  const doc = overviewTemplate("D");
  const before = JSON.stringify(doc);
  const renamed = upsertWidget(doc, { ...doc.widgets[1], title: "Renamed" });
  expect(renamed.widgets[1].title).toBe("Renamed");
  expect(renamed.widgets.length).toBe(7);
  const added = upsertWidget(doc, { ...doc.widgets[0], id: "extra" });
  expect(ids(added).at(-1)).toBe("extra");
  expect(ids(removeWidget(doc, "sources"))).toEqual([
    "events",
    "activity",
    "breakdown",
    "actors",
    "success",
    "duration",
  ]);
  expect(JSON.stringify(doc)).toBe(before);
});

test("queryLabel names what a query measures", () => {
  expect(queryLabel({ signal: "events" })).toBe("Events");
  expect(queryLabel({ signal: "events", measure: "count", event: "signup" })).toBe("Events");
  expect(queryLabel({ signal: "events", measure: "actors" })).toBe("Actors");
  expect(queryLabel({ signal: "events", measure: "avg", property: "duration_ms" })).toBe(
    "Avg duration_ms",
  );
  expect(queryLabel({ signal: "events", measure: "p95", property: "duration_ms" })).toBe(
    "p95 duration_ms",
  );
  expect(queryLabel({ signal: "events", measure: "sum", property: "amount" })).toBe("Sum amount");
  expect(queryLabel({ signal: "logs", min_level: "error" })).toBe("Logs");
  expect(queryLabel({ signal: "logs", measure: "max", attribute: "latency" })).toBe("Max latency");
  expect(queryLabel({ signal: "logs", measure: "min", attribute: "latency" })).toBe("Min latency");
  expect(queryLabel({ signal: "logs", measure: "p50", attribute: "latency" })).toBe("p50 latency");
});

test("seriesDisplayLabel prefers explicit labels, then measures, then the expression", () => {
  const base = {
    id: "w",
    title: "W",
    view: { type: "line" as const },
    queries: {
      a: { signal: "events" as const },
      errors: { signal: "logs" as const, min_level: "error" },
      requests: { signal: "events" as const, event: "checkout_request" },
      latency: { signal: "events" as const, measure: "avg" as const, property: "duration_ms" },
    },
  };
  // Without series, each query is one series in order.
  expect(seriesDisplayLabel(base, 0)).toBe("Events");
  expect(seriesDisplayLabel(base, 1)).toBe("Logs");
  expect(seriesDisplayLabel(base, 3)).toBe("Avg duration_ms");
  expect(seriesDisplayLabel(base, 9)).toBeUndefined();
  const named: Widget = {
    ...base,
    series: [
      { expr: "errors / requests * 100" },
      { expr: "a", label: "Signups" },
      { expr: " latency " },
      { expr: "constructor" },
    ],
  };
  expect(seriesDisplayLabel(named, 0)).toBe("errors / requests * 100");
  expect(seriesDisplayLabel(named, 1)).toBe("Signups");
  expect(seriesDisplayLabel(named, 2)).toBe("Avg duration_ms");
  // Object prototype keys are not queries.
  expect(seriesDisplayLabel(named, 3)).toBe("constructor");
  expect(hasSeriesLabel(named, 0)).toBe(false);
  expect(hasSeriesLabel(named, 1)).toBe(true);
  expect(hasSeriesLabel(base, 0)).toBe(false);
});

test("SQL queries are labelled by their series label or query id", () => {
  const widget = {
    id: "w",
    title: "W",
    view: { type: "line" as const },
    queries: {
      slow: { signal: "sql" as const, database: "events" as const, sql: "SELECT 1" },
    },
  };
  expect(queryLabel(widget.queries.slow)).toBe("SQL");
  expect(seriesDisplayLabel(widget, 0)).toBe("slow");
  expect(seriesDisplayLabel({ ...widget, series: [{ expr: "slow", label: "Slow" }] }, 0)).toBe(
    "Slow",
  );
});

test("table columns accept objects and pairs and stop at 50", () => {
  expect(tableColumns([{ name: "a", type: "BIGINT" }, ["b", "VARCHAR"]])).toEqual([
    { name: "a", type: "BIGINT" },
    { name: "b", type: "VARCHAR" },
  ]);
  expect(tableColumns(null)).toEqual([]);
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, type: "INTEGER" }));
  expect(tableColumns(many)).toHaveLength(50);
});

test("cellKind groups DuckDB types", () => {
  expect(cellKind("BIGINT")).toBe("number");
  expect(cellKind("DECIMAL(18,3)")).toBe("number");
  expect(cellKind("DOUBLE")).toBe("number");
  expect(cellKind("HUGEINT")).toBe("number");
  expect(cellKind("TIMESTAMP")).toBe("timestamp");
  expect(cellKind("TIMESTAMP WITH TIME ZONE")).toBe("timestamp");
  expect(cellKind("TIMESTAMP_MS")).toBe("timestamp");
  expect(cellKind("DATE")).toBe("date");
  expect(cellKind("BOOLEAN")).toBe("boolean");
  expect(cellKind("JSON")).toBe("json");
  expect(cellKind("STRUCT(a INTEGER)")).toBe("json");
  expect(cellKind("VARCHAR[]")).toBe("json");
  expect(cellKind("MAP(VARCHAR, INTEGER)")).toBe("json");
  expect(cellKind("VARCHAR")).toBe("text");
  expect(cellKind("UUID")).toBe("text");
  expect(cellKind("TIME")).toBe("text");
});

test("formatCell renders nulls, numbers and booleans as text", () => {
  expect(formatCell(null, "number")).toBe("—");
  expect(formatCell(1234567, "number")).toBe("1,234,567");
  expect(formatCell(12.34567, "number")).toBe("12.3457");
  expect(formatCell(true, "boolean")).toBe("true");
  expect(formatCell(false, "boolean")).toBe("false");
  expect(formatCell("hello", "text")).toBe("hello");
  expect(formatCell("", "text")).toBe("");
  expect(formatCell("n/a", "number")).toBe("n/a");
  expect(formatCell(Date.UTC(2026, 0, 2), "date")).toBe("2026-01-02");
});

test("tableNotes says when rows were cut", () => {
  expect(TABLE_ROW_LIMIT).toBe(500);
  expect(tableNotes(10, [])).toEqual([]);
  expect(tableNotes(600, [])).toEqual(["Showing the first 500 of 600 rows"]);
  expect(
    tableNotes(10000, [{ path: "/queries/q/sql", message: "Showing the first 10,000 rows" }]),
  ).toEqual(["Showing the first 500 rows", "Showing the first 10,000 rows"]);
  expect(
    tableNotes(3, [
      { path: "/queries/q/sql", message: "The first row is larger than the 4 MB limit" },
      { path: "/x", message: "Something else" },
    ]),
  ).toEqual(["The first row is larger than the 4 MB limit"]);
});

test("formatCell keeps large integers, decimals and identifiers exact", () => {
  expect(formatCell("9007199254740993", "number")).toBe("9007199254740993");
  expect(formatCell("0.00001", "number")).toBe("0.00001");
  expect(formatCell("-1.230", "number")).toBe("-1.230");
  expect(formatCell(0.00001, "number")).toBe("0.00001");
  expect(formatCell(0.123456789, "number")).toBe("0.123457");
  expect(formatCell(0, "number")).toBe("0");
  expect(formatCell(1234567, "number", "events")).toBe("1,234,567");
  expect(formatCell(1234567, "number", "user_id")).toBe("1234567");
  expect(formatCell(1234567, "number", "id")).toBe("1234567");
  expect(formatCell(NaN, "number")).toBe("NaN");
  expect(formatCell(Infinity, "number")).toBe("Infinity");
  expect(formatCell(-Infinity, "number")).toBe("-Infinity");
});

test("times beyond the Date range fall back to text", () => {
  const nineK = Date.UTC(9999, 11, 31);
  expect(validTime(nineK)).toBe(nineK);
  expect(validTime(8.64e15)).toBe(8.64e15);
  expect(validTime(8.64e15 + 1)).toBeNull();
  expect(validTime("253402300800000000")).toBeNull();
  expect(formatCell(nineK, "date")).toBe("9999-12-31");
  expect(formatCell(8.7e15, "date")).toBe("8700000000000000");
  expect(formatCell("253402300800000000", "timestamp")).toBe("253402300800000000");
});

test("JSON columns parse their text", () => {
  expect(parseJsonCell('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonCell("not json")).toBe("not json");
  expect(parseJsonCell({ a: 1 })).toEqual({ a: 1 });
});

test("a duration is better when it falls unless the view says otherwise", () => {
  expect(lowerIsBetter({})).toBe(false);
  expect(lowerIsBetter({ unit: "ms" })).toBe(true);
  expect(lowerIsBetter({ unit: "seconds" })).toBe(true);
  expect(lowerIsBetter({ unit: "percent" })).toBe(false);
  expect(lowerIsBetter({ unit: "ms", better: "up" })).toBe(false);
  expect(lowerIsBetter({ unit: "number", better: "down" })).toBe(true);
});
