import { describe, expect, test } from "bun:test";
import schema from "../src/server/dashboards/dashboard.v1.schema.json";
import { evaluate, parseFormula, references } from "../src/server/dashboards/formula";
import { nearest } from "../src/server/dashboards/suggest";
import {
  checkDocument,
  checkWidget,
  limitsJson,
  MAX_DOCUMENT_BYTES,
  parseDocument,
  parseWidget,
  Report,
  serializeDocument,
} from "../src/server/dashboards/validate";

type Json = any;

const doc = (widgets: Json) => ({ version: 1, name: "Checkout health", widgets });

function line(): Json {
  return {
    id: "error-rate",
    title: "Error rate",
    view: { type: "line", unit: "percent" },
    queries: {
      errors: { signal: "logs", min_level: "error" },
      requests: { signal: "events", event: "checkout_request" },
    },
    series: [
      {
        expr: "errors / requests * 100",
        color: "red",
        thresholds: [
          { at: 1, color: "yellow" },
          { at: 5, color: "red" },
        ],
      },
    ],
  };
}

function parsed(value: Json) {
  const result = parseDocument(value);
  if (!result.ok) throw new Error(JSON.stringify(result.report.errors));
  return result.value;
}

const errors = (widgets: Json) => checkDocument(parsed(doc(widgets))).errors.map((i) => i.path);
const shapeError = (value: Json) => {
  const result = parseDocument(value);
  if (result.ok) throw new Error("expected a shape error");
  return result.report.errors[0];
};

const funnel = (extra: Json = {}) => ({
  signal: "funnel",
  steps: [{ event: "visit" }, { event: "signup" }],
  ...extra,
});
const retention = (extra: Json = {}) => ({
  signal: "retention",
  start: { event: "signup" },
  return: { event: "page_view" },
  ...extra,
});

describe("dashboard documents", () => {
  test("spec_example_is_valid", () => {
    expect(checkDocument(parsed(doc([line()]))).errors).toEqual([]);
  });

  test("unknown_fields_and_bad_enums_have_pointer_paths", () => {
    const misspelt = line();
    misspelt.queries.errors.min_levle = "warn";
    expect(shapeError(doc([misspelt]))?.path).toBe("/widgets/0/queries/errors/min_levle");
    expect(shapeError(doc([misspelt]))?.message).toStartWith("unknown field `min_levle`");
    const colour = line();
    colour.series[0].color = "orange";
    expect(shapeError(doc([colour]))?.path).toBe("/widgets/0/series/0/color");
    expect(shapeError(doc([colour]))?.message).toStartWith("unknown variant `orange`");
    expect(checkDocument(parsed({ version: 2, name: "x", widgets: [] })).errors[0]?.path).toBe(
      "/version",
    );
    const signal = line();
    signal.queries.errors.signal = "metrics";
    expect(shapeError(doc([signal]))?.path).toBe("/widgets/0/queries/errors/signal");
    const missing = line();
    delete missing.title;
    expect(shapeError(doc([missing]))).toMatchObject({
      path: "/widgets/0",
      message: "missing field `title`",
    });
  });

  test("rule_errors", () => {
    const cases: [Json, string][] = [
      [
        {
          id: "a",
          title: "t",
          view: { type: "line" },
          queries: { a: { signal: "events" }, b: { signal: "events" } },
          series: [{ expr: "a" }],
        },
        "/widgets/0/queries/b",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "ranking" },
          queries: {
            a: { signal: "events", group_by: "name" },
            b: { signal: "events", group_by: "source" },
          },
          series: [{ expr: "a/b" }],
        },
        "/widgets/0/queries/b/group_by",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: { a: { signal: "logs", level: "error", min_level: "warn" } },
        },
        "/widgets/0/queries/a/min_level",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: { a: { signal: "events", measure: "avg" } },
        },
        "/widgets/0/queries/a/property",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          size: { w: 5, h: 1 },
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/size/w",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          timeout_ms: 20000,
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/timeout_ms",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "line", markdown: "x" },
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/view/markdown",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "line" },
          queries: { a: { signal: "events", group_by: "name" } },
          series: [{ expr: "a" }, { expr: "a*2" }],
        },
        "/widgets/0/series/1",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          range: "2w",
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/range",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: { a: { signal: "events" } },
          series: [
            {
              expr: "a",
              thresholds: [
                { at: 5, color: "red" },
                { at: 1, color: "green" },
              ],
            },
          ],
        },
        "/widgets/0/series/0/thresholds/1",
      ],
    ];
    for (const [widget, path] of cases)
      expect({ path, found: errors([widget]).includes(path) }).toEqual({ path, found: true });
  });

  test("more_rule_errors", () => {
    const cases: [Json, string][] = [
      [
        { id: "Bad_ID", title: "t", view: { type: "stat" }, queries: { a: { signal: "events" } } },
        "/widgets/0/id",
      ],
      [
        { id: "a", title: "", view: { type: "stat" }, queries: { a: { signal: "events" } } },
        "/widgets/0/title",
      ],
      [
        { id: "a", title: "t", view: { type: "stat" }, queries: { A: { signal: "events" } } },
        "/widgets/0/queries/A",
      ],
      [{ id: "a", title: "t", view: { type: "text" } }, "/widgets/0/view/markdown"],
      [
        {
          id: "a",
          title: "t",
          view: { type: "text", markdown: "x" },
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/queries",
      ],
      [{ id: "a", title: "t", view: { type: "stat" } }, "/widgets/0/queries"],
      [
        { id: "a", title: "t", view: { type: "events" }, queries: { a: { signal: "logs" } } },
        "/widgets/0/queries/a",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "events" },
          queries: { a: { signal: "events", measure: "sum", property: "x" } },
        },
        "/widgets/0/queries/a/measure",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "logs" },
          queries: { a: { signal: "logs", group_by: "level" } },
        },
        "/widgets/0/queries/a/group_by",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "events" },
          queries: { a: { signal: "events" } },
          series: [{ expr: "a" }],
        },
        "/widgets/0/series",
      ],
      [
        { id: "a", title: "t", view: { type: "ranking" }, queries: { a: { signal: "events" } } },
        "/widgets/0/queries/a/group_by",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "ranking", limit: 51 },
          queries: { a: { signal: "events", group_by: "name" } },
        },
        "/widgets/0/view/limit",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "line", bucket: "year" },
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/view/bucket",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: { a: { signal: "logs", level: "loud" } },
        },
        "/widgets/0/queries/a/level",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: { a: { signal: "logs", min_level: "info" } },
        },
        "/widgets/0/queries/a/min_level",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "ranking" },
          queries: { a: { signal: "logs", group_by: "name" } },
        },
        "/widgets/0/queries/a/group_by",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: { a: { signal: "events" } },
          series: [{ expr: "a +" }],
        },
        "/widgets/0/series/0/expr",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat", decimals: 5 },
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/view/decimals",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat", prefix: "123456789" },
          queries: { a: { signal: "events" } },
        },
        "/widgets/0/view/prefix",
      ],
      [
        {
          id: "a",
          title: "t",
          view: { type: "stat" },
          queries: {
            a: { signal: "events", filters: [{ property: "bad key", op: "eq", value: 1 }] },
          },
        },
        "/widgets/0/queries/a/filters/0/property",
      ],
    ];
    for (const [widget, path] of cases)
      expect({ path, found: errors([widget]).includes(path) }).toEqual({ path, found: true });
  });

  test("funnel_and_retention_rules", () => {
    const w = (view: string, queries: Json, extra: Json = {}) => ({
      id: "a",
      title: "t",
      view: { type: view },
      queries,
      ...extra,
    });
    const steps = (k: number) => Array.from({ length: k }, (_, i) => ({ event: `e${i}` }));
    const cases: [Json, string][] = [
      [w("ranking", { f: funnel({ steps: steps(1) }) }), "/widgets/0/queries/f/steps"],
      [w("ranking", { f: funnel({ steps: steps(9) }) }), "/widgets/0/queries/f/steps"],
      [w("ranking", { f: funnel({ window: "0h" }) }), "/widgets/0/queries/f/window"],
      [w("ranking", { f: funnel({ window: "2w" }) }), "/widgets/0/queries/f/window"],
      [
        w("ranking", { f: funnel({ steps: [{ event: "" }, { event: "b" }] }) }),
        "/widgets/0/queries/f/steps/0/event",
      ],
      [
        w("ranking", {
          f: funnel({
            steps: [
              { event: "a", filters: [{ property: "p", op: "gt", value: "x" }] },
              { event: "b" },
            ],
          }),
        }),
        "/widgets/0/queries/f/steps/0/filters/0/value",
      ],
      [w("stat", { f: funnel() }), "/widgets/0/queries/f"],
      [w("line", { f: funnel() }), "/widgets/0/queries/f"],
      [
        w(
          "ranking",
          { f: funnel(), b: { signal: "events", group_by: "name" } },
          {
            series: [{ expr: "f" }, { expr: "b" }],
          },
        ),
        "/widgets/0/queries",
      ],
      [w("ranking", { r: retention() }), "/widgets/0/queries/r"],
      [w("table", { r: retention(), f: funnel() }), "/widgets/0/queries"],
      [w("table", { r: retention({ periods: 0 }) }), "/widgets/0/queries/r/periods"],
      [w("table", { r: retention({ periods: 13 }) }), "/widgets/0/queries/r/periods"],
      [w("table", { r: retention() }, { series: [{ expr: "r" }] }), "/widgets/0/series"],
      [w("table", { a: { signal: "events" } }), "/widgets/0/queries/a/group_by"],
      [
        w("table", {
          a: { signal: "events", group_by: "name" },
          b: { signal: "events", group_by: "source" },
        }),
        "/widgets/0/queries/b/group_by",
      ],
      [w("events", { f: funnel() }), "/widgets/0/queries/f"],
    ];
    for (const [widget, path] of cases)
      expect({ path, found: errors([widget]) }).toEqual({
        path,
        found: expect.arrayContaining([path]),
      });
    for (const widget of [
      w("ranking", { f: funnel() }),
      w(
        "ranking",
        { f: funnel({ steps: steps(8), window: "24h", by: "session" }) },
        {
          series: [{ expr: "f * 2" }],
        },
      ),
      w("table", { f: funnel() }),
      w("table", { r: retention({ periods: 12, period: "month" }) }, { range: "366d" }),
      w("table", {
        a: { signal: "events", group_by: "name" },
        b: { signal: "events", measure: "actors", group_by: "name" },
      }),
      w("table", { a: { signal: "logs", group_by: "service" } }),
    ])
      expect(errors([widget])).toEqual([]);
    // A retention widget whose range cannot hold its periods says so.
    const short = checkDocument(parsed(doc([w("table", { r: retention() }, { range: "14d" })])));
    expect(short.errors).toEqual([]);
    expect(short.warnings.map((i) => i.path)).toContain("/widgets/0/queries/r/periods");
    const sqlQuery = shapeError(
      doc([w("stat", { a: { signal: "sql", database: "events", sql: "SELECT 1 AS value" } })]),
    );
    expect(sqlQuery?.path).toBe("/widgets/0/queries/a/signal");
    expect(sqlQuery?.message).toBe(
      "unknown variant `sql`, expected one of `events`, `logs`, `funnel`, `retention`",
    );
    expect(shapeError(doc([w("table", { r: retention({ period: "year" }) })]))?.path).toBe(
      "/widgets/0/queries/r/period",
    );
    expect(shapeError(doc([w("ranking", { f: funnel({ by: "device" }) })]))?.path).toBe(
      "/widgets/0/queries/f/by",
    );
    expect(JSON.stringify(limitsJson())).not.toContain("sql");
  });

  test("long_ranges_warn_and_malformed_ranges_never_panic", () => {
    const w = (range: string, signal: Json, view: Json) => ({
      id: "a",
      title: "t",
      view,
      range,
      queries: { a: signal },
    });
    const cases: [Json, string][] = [
      [w("400d", { signal: "events" }, { type: "stat" }), "/widgets/0/range"],
      [w("90d", { signal: "logs" }, { type: "stat" }), "/widgets/0/range"],
      [w("100d", { signal: "events" }, { type: "line", bucket: "hour" }), "/widgets/0/view/bucket"],
    ];
    for (const [widget, path] of cases) {
      const report = checkDocument(parsed(doc([widget])));
      expect(report.errors).toEqual([]);
      expect(report.warnings.some((i) => i.path === path)).toBe(true);
    }
    expect(errors([w("5é", { signal: "events" }, { type: "stat" })])).toContain("/widgets/0/range");
  });

  test("formula_errors_carry_the_column", () => {
    const w = line();
    w.series[0].expr = "erors / requests";
    const issue = checkDocument(parsed(doc([w]))).errors.find(
      (i) => i.path === "/widgets/0/series/0/expr",
    );
    expect(issue?.message).toContain("at column 1");
    expect(issue?.message).toContain("did you mean `errors`");
  });

  test("document_limits", () => {
    const w = (i: number) => ({
      id: `w${i}`,
      title: "t",
      view: { type: "stat" },
      queries: { a: { signal: "events" } },
    });
    expect(errors(Array.from({ length: 25 }, (_, i) => w(i)))).toContain("/widgets");
    expect(errors([w(1), w(1)])).toContain("/widgets/1/id");
  });

  test("query_run_budget_counts_previous_period", () => {
    const over = line();
    over.view.compare = "previous_period";
    for (const id of ["c", "d", "e", "f", "g"]) over.queries[id] = { signal: "events" };
    over.series = [{ expr: "errors+requests+c+d+e+f+g" }];
    expect(errors([over])).toContain("/widgets/0/queries");
    const six = line();
    six.view.compare = "previous_period";
    for (const id of ["c", "d", "e", "f"]) six.queries[id] = { signal: "events" };
    six.series = ["errors", "requests", "c", "d", "e", "f"].map((expr) => ({ expr }));
    expect(errors([six])).toEqual([]);
    const seven = structuredClone(six);
    seven.series.push({ expr: "c * 2" });
    expect(errors([seven])).toContain("/widgets/0/series");
    const warned = line();
    warned.view.compare = "previous_period";
    warned.queries.c = { signal: "events" };
    warned.queries.d = { signal: "events" };
    warned.series = [{ expr: "errors+requests+c+d" }];
    const report = checkDocument(parsed(doc([warned])));
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((i) => i.path === "/widgets/0/queries")).toBe(true);
  });

  test("filter_ops_and_measures_rules", () => {
    const stat = (query: Json) => ({
      id: "a",
      title: "t",
      view: { type: "stat" },
      queries: { a: query },
    });
    const events = (filter: Json) => stat({ signal: "events", filters: [filter] });
    const logs = (filter: Json) => stat({ signal: "logs", filters: [filter] });
    const value = "/widgets/0/queries/a/filters/0/value";
    const cases: [Json, string][] = [
      [events({ property: "p", op: "exists", value: 1 }), value],
      [events({ property: "p", op: "eq" }), value],
      [events({ property: "p", op: "in", value: "x" }), value],
      [events({ property: "p", op: "in", value: [] }), value],
      [events({ property: "p", op: "in", value: Array.from({ length: 51 }, (_, i) => i) }), value],
      [events({ property: "p", op: "in", value: [{ a: 1 }] }), value],
      [events({ property: "p", op: "contains", value: 5 }), value],
      [logs({ attribute: "a", op: "gt", value: "x" }), value],
      [logs({ attribute: "a", op: "not_exists", value: true }), value],
      [stat({ signal: "events", measure: "unique" }), "/widgets/0/queries/a/property"],
      [
        stat({ signal: "events", measure: "sessions", property: "p" }),
        "/widgets/0/queries/a/property",
      ],
      [stat({ signal: "logs", measure: "unique" }), "/widgets/0/queries/a/attribute"],
      [
        stat({
          signal: "funnel",
          steps: [{ event: "a", filters: [{ property: "p", op: "in", value: 1 }] }, { event: "b" }],
        }),
        "/widgets/0/queries/a/steps/0/filters/0/value",
      ],
    ];
    for (const [widget, path] of cases)
      expect({ path, found: errors([widget]) }).toEqual({
        path,
        found: expect.arrayContaining([path]),
      });
    for (const widget of [
      events({ property: "p", op: "exists" }),
      events({ property: "p", op: "not_in", value: ["a", 1, true] }),
      events({ property: "p", op: "not_contains", value: "x" }),
      logs({ attribute: "a", op: "lte", value: 3 }),
      logs({ attribute: "a", value: "eu" }),
      stat({ signal: "events", measure: "unique", property: "p" }),
      stat({ signal: "events", measure: "new_actors", event: "signup" }),
      stat({ signal: "events", measure: "returning_actors" }),
      stat({ signal: "events", measure: "p99", property: "ms" }),
      stat({ signal: "logs", measure: "p90", attribute: "ms" }),
    ])
      expect(errors([widget])).toEqual([]);
    const like = shapeError(doc([events({ property: "p", op: "like", value: "x" })]));
    expect(like?.path).toBe("/widgets/0/queries/a/filters/0/op");
    expect(like?.message).toStartWith("unknown variant `like`");
    expect(limitsJson().max_queries_per_widget).toBe(6);
    expect(limitsJson().max_series_per_widget).toBe(6);
    expect(limitsJson().max_query_runs_per_widget).toBe(12);
    expect(limitsJson().max_in_values).toBe(50);
  });

  test("invalid_group_by_keys_are_errors", () => {
    expect(
      errors([
        {
          id: "a",
          title: "t",
          view: { type: "ranking" },
          queries: { a: { signal: "events", group_by: "property:bad key" } },
        },
      ]),
    ).toContain("/widgets/0/queries/a/group_by");
    expect(
      errors([
        {
          id: "a",
          title: "t",
          view: { type: "ranking" },
          queries: { a: { signal: "logs", group_by: "attribute:route" } },
        },
      ]),
    ).toEqual([]);
  });

  test("document_size_limit_is_inclusive", () => {
    const base = parsed(doc([]));
    const overhead = new TextEncoder().encode(serializeDocument({ ...base, $schema: "" })).length;
    const exact = { ...base, $schema: "x".repeat(MAX_DOCUMENT_BYTES - overhead) };
    expect(new TextEncoder().encode(serializeDocument(exact)).length).toBe(MAX_DOCUMENT_BYTES);
    expect(checkDocument(exact).errors).toEqual([]);
    expect(
      checkDocument({ ...exact, $schema: `${exact.$schema}x` }).errors.some((i) => i.path === ""),
    ).toBe(true);
  });

  test("widget_parsing_and_limits_json", () => {
    const widget = parseWidget(line());
    if (!widget.ok) throw new Error("widget parses");
    const report = new Report();
    checkWidget(widget.value, "", report);
    expect(report.ok).toBe(true);
    const bad = line();
    bad.id = 5;
    const failed = parseWidget(bad);
    expect(failed.ok ? null : failed.report.errors[0]?.path).toBe("/id");
    expect(limitsJson().max_widgets).toBe(24);
  });

  test("schema_is_draft_2020_and_names_colors", () => {
    expect(schema.$id).toBe("/api/read/schemas/dashboard.v1.json");
    expect(schema.$schema).toContain("2020-12");
    const text = JSON.stringify(schema);
    expect(text.includes('"yellow"') && !text.includes('"orange"')).toBe(true);
    expect(text).not.toContain("DuckDB");
  });

  test("the_validator_and_the_schema_name_the_same_fields", () => {
    // Every field the schema names parses; any other field is refused.
    const full = {
      $schema: "/api/read/schemas/dashboard.v1.json",
      version: 1,
      name: "All fields",
      description: "d",
      widgets: [
        {
          id: "w",
          title: "t",
          description: "d",
          view: {
            type: "line",
            unit: "ms",
            decimals: 1,
            prefix: "",
            suffix: "",
            sparkline: true,
            compare: "none",
            better: "down",
            bucket: "day",
            stacked: false,
            limit: 5,
          },
          size: { w: 6, h: 2 },
          range: "7d",
          timeout_ms: 2000,
          queries: {
            a: {
              signal: "events",
              event: "e",
              source_id: "s",
              identity_kind: "visitor",
              measure: "avg",
              property: "p",
              filters: [{ property: "p", op: "gt", value: 1 }],
              group_by: "name",
            },
            b: {
              signal: "logs",
              level: "error",
              service: "api",
              environment: "prod",
              source_id: "s",
              search: "x",
              filters: [{ attribute: "a", value: 1 }],
              measure: "avg",
              attribute: "ms",
              group_by: "service",
            },
            c: {
              signal: "funnel",
              steps: [
                { event: "a", filters: [{ property: "p", op: "eq", value: "x" }] },
                { event: "b" },
              ],
              window: "1d",
              by: "actor",
              source_id: "s",
            },
            d: {
              signal: "retention",
              start: { event: "a", filters: [{ property: "p", op: "eq", value: "x" }] },
              return: { event: "b" },
              period: "week",
              periods: 4,
              source_id: "s",
            },
          },
          series: [
            {
              expr: "a",
              label: "l",
              color: "aqua",
              unit: "ms",
              thresholds: [{ at: 1, color: "red" }],
            },
          ],
        },
      ],
    };
    expect(parseDocument(full).ok).toBe(true);
    for (const [path, mutate] of [
      ["/extra", (d: Json) => (d.extra = 1)],
      ["/widgets/0/extra", (d: Json) => (d.widgets[0].extra = 1)],
      ["/widgets/0/view/extra", (d: Json) => (d.widgets[0].view.extra = 1)],
      ["/widgets/0/size/extra", (d: Json) => (d.widgets[0].size.extra = 1)],
      ["/widgets/0/queries/a/extra", (d: Json) => (d.widgets[0].queries.a.extra = 1)],
      ["/widgets/0/queries/b/extra", (d: Json) => (d.widgets[0].queries.b.extra = 1)],
      ["/widgets/0/queries/c/extra", (d: Json) => (d.widgets[0].queries.c.extra = 1)],
      [
        "/widgets/0/queries/c/steps/1/extra",
        (d: Json) => (d.widgets[0].queries.c.steps[1].extra = 1),
      ],
      ["/widgets/0/queries/d/extra", (d: Json) => (d.widgets[0].queries.d.extra = 1)],
      ["/widgets/0/queries/d/return/extra", (d: Json) => (d.widgets[0].queries.d.return.extra = 1)],
      ["/widgets/0/series/0/extra", (d: Json) => (d.widgets[0].series[0].extra = 1)],
      [
        "/widgets/0/series/0/thresholds/0/extra",
        (d: Json) => (d.widgets[0].series[0].thresholds[0].extra = 1),
      ],
      [
        "/widgets/0/queries/a/filters/0/extra",
        (d: Json) => (d.widgets[0].queries.a.filters[0].extra = 1),
      ],
    ] as const) {
      const copy = structuredClone(full);
      mutate(copy);
      expect(shapeError(copy)?.path).toBe(path);
    }
  });
});

describe("formulas", () => {
  const value = (expr: string, values: Record<string, number | null> = {}) => {
    const parsedFormula = parseFormula(expr, Object.keys(values));
    if (!parsedFormula.ok) throw new Error(parsedFormula.error.message);
    return evaluate(parsedFormula.expr, (id) => values[id] ?? null);
  };

  test("precedence_and_parentheses", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("-2 * -3")).toBe(6);
    expect(value("a / b * 100", { a: 1, b: 4 })).toBe(25);
    expect(value("max(a, b) - min(a, b) + abs(-1)", { a: 3, b: 5 })).toBe(3);
    expect(value("1.5e2")).toBe(150);
  });

  test("nulls_division_by_zero_and_non_finite_are_null", () => {
    expect(value("a + 1", { a: null })).toBeNull();
    expect(value("1 / 0")).toBeNull();
    expect(value("a / b", { a: 1, b: 0 })).toBeNull();
    expect(value("1e308 * 10")).toBeNull();
  });

  test("unknown_query_reports_column_and_suggestion", () => {
    const result = parseFormula("errors / requsts", ["errors", "requests"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.column).toBe(10);
    expect(result.error.message).toBe("unknown query `requsts`; did you mean `requests`?");
    expect(nearest("erors", ["errors", "requests"])).toBe("errors");
    expect(nearest("nothing", ["errors", "requests"])).toBeNull();
  });

  test("limits_and_syntax_errors", () => {
    const error = (expr: string) => {
      const result = parseFormula(expr, ["a"]);
      return result.ok ? null : result.error;
    };
    expect(error("a".repeat(201))?.message).toBe("formula is longer than 200 characters");
    expect(error(`${"(".repeat(17)}a${")".repeat(17)}`)?.message).toBe(
      "nesting is deeper than 16 levels",
    );
    expect(error("a +")?.message).toBe(
      "expected a number, query or `(`, found the end of the formula",
    );
    expect(error("a $")?.message).toBe("unexpected character `$`");
    expect(error("sum(a)")?.message).toBe(
      "unknown function `sum`; available functions: min, max, abs",
    );
    expect(error("max(a)")?.message).toBe("`max` takes 2 arguments, found 1");
    expect(error("a a")?.message).toBe("unexpected `a`");
    expect(error("1e")?.message).toBe("expected digits in the exponent");
  });

  test("columns_count_characters_not_bytes", () => {
    const result = parseFormula("1 + ü", ["a"]);
    expect(result.ok ? null : result.error.column).toBe(5);
  });

  test("references_lists_query_ids", () => {
    const result = parseFormula("b + a * b", ["a", "b"]);
    if (!result.ok) throw new Error("parses");
    expect([...references(result.expr)]).toEqual(["a", "b"]);
  });
});
