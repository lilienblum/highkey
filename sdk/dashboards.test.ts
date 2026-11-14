import { expect, test } from "bun:test";
import {
  blankDocument,
  duplicateWidget,
  formatMeasure,
  hasSeriesLabel,
  moveWidget,
  overviewTemplate,
  queryLabel,
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
