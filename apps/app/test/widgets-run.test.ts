import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { overviewTemplate } from "../src/lib/dashboards";
import { call, project, seedEvents, seedLogs, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await testContext();
}, 300_000);

afterEach(() => ctx?.cleanup());

const HOUR = 3_600_000;
const DAY = 86_400_000;

function window(days: number) {
  const to = new Date(Date.now() + 60_000);
  return { from: new Date(to.getTime() - days * DAY).toISOString(), to: to.toISOString() };
}

const runBody = (widget: unknown, days: number, extra: Record<string, unknown> = {}) => ({
  widget,
  ...window(days),
  ...extra,
});
const run = (key: string, body: unknown) =>
  call(ctx, "POST", `/api/read/products/${key}/widgets/run`, body);

function errorRate() {
  return {
    id: "error-rate",
    title: "Checkout error rate",
    description: "Share of checkout requests that logged an error",
    view: { type: "line", unit: "percent", decimals: 1, compare: "previous_period" },
    size: { w: 6, h: 2 },
    range: "24h",
    timeout_ms: 5000,
    queries: {
      errors: { signal: "logs", min_level: "error", service: "checkout" },
      requests: { signal: "events", event: "checkout_request" },
    },
    series: [
      {
        expr: "errors / requests * 100",
        label: "Error rate",
        color: "red",
        thresholds: [
          { at: 1, color: "yellow" },
          { at: 5, color: "red" },
        ],
      },
    ],
  };
}

const many = <T>(n: number, row: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => row(i));

describe("widget runs", () => {
  test("widgets_run_over_events_and_logs_by_slug", async () => {
    const shop = await project(ctx, "Checkout Shop");
    const at = new Date(Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR + 30 * 60_000);
    await seedEvents(shop.id, [
      ...many(8, (i) => ({ event_id: `c${i}`, name: "checkout_request", time: at })),
      ...many(3, (i) => ({ event_id: `p${i}`, name: "page_view", time: at })),
    ]);
    await seedLogs(shop.id, [
      { log_id: "e1", service: "checkout", level: "error", time: at },
      { log_id: "f1", service: "checkout", level: "fatal", time: at },
      ...many(5, (i) => ({ log_id: `i${i}`, service: "checkout", level: "info", time: at })),
      ...many(4, (i) => ({ log_id: `s${i}`, service: "search", level: "error", time: at })),
    ]);
    const reply = await run("checkout-shop", runBody(errorRate(), 7));
    expect(reply.status).toBe(200);
    const body = reply.json;
    expect(body.widget).toBe("error-rate");
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toMatchObject({
      label: "Error rate",
      color: "red",
      total: 25,
      previous_total: null,
    });
    expect(body.series[0].points.some((p: { value: number }) => p.value === 25)).toBe(true);
    expect(Array.isArray(body.series[0].previous_points)).toBe(true);
    expect(body.range).toMatchObject({ clamped: false, bucket: "hour" });
    expect(Date.parse(body.range.to) - Date.parse(body.range.from)).toBe(24 * HOUR);
    expect(body.range.requested_from).toBe(body.range.from);
    expect(Number.isInteger(body.elapsed_ms)).toBe(true);
    expect(body.rows).toBeNull();
    expect(body.warnings).toEqual([]);
    expect((await run(shop.id, runBody(errorRate(), 7))).json.series[0].total).toBe(25);
    expect((await run("missing", runBody(errorRate(), 7))).status).toBe(404);
  });

  test("ninety_day_run_with_logs_reports_clamp", async () => {
    const clamp = await project(ctx, "Clamp");
    await seedLogs(
      clamp.id,
      many(3, (i) => ({ log_id: `e${i}`, level: "error" })),
    );
    const widget = {
      id: "errors",
      title: "Errors",
      view: { type: "line" },
      queries: { errors: { signal: "logs", min_level: "error" } },
    };
    const w = window(90);
    const body = (await run("clamp", { widget, ...w, bucket: "auto" })).json;
    expect(body.range.clamped).toBe(true);
    expect(body.range.requested_from).toBe(w.from);
    expect(Date.parse(body.range.from)).toBe(Date.parse(w.to) - 31 * DAY);
    expect(body.range.bucket).toBe("day");
    expect(body.warnings[0].path).toBe("/range");
    expect(body.warnings[0].message).toContain("31 days");
    expect(body.series[0].total).toBe(3);
    const views = {
      id: "views",
      title: "Views",
      view: { type: "stat" },
      queries: { views: { signal: "events", event: "page_view" } },
    };
    const events = (await run("clamp", runBody(views, 90))).json;
    expect(events.range.clamped).toBe(false);
    expect(events.series[0].total).toBe(0);
  });

  test("invalid_widget_returns_pointer_errors", async () => {
    const invalid = await project(ctx, "Invalid");
    const misspelt = errorRate();
    misspelt.series[0].expr = "erors/requests";
    const body = (await run("invalid", runBody(misspelt, 7))).json;
    expect(body).toMatchObject({ code: "invalid_document", error: "Invalid dashboard document" });
    expect(body.errors[0].path).toBe("/series/0/expr");
    expect(Array.isArray(body.warnings)).toBe(true);
    const colour: Record<string, unknown> = errorRate();
    (colour.view as Record<string, unknown>).colour = "red";
    const shape = await run(invalid.id, runBody(colour, 7));
    expect(shape.status).toBe(400);
    expect(shape.json.errors[0].path).toBe("/view/colour");
    const w = window(7);
    for (const request of [
      { widget: errorRate(), from: w.to, to: w.from },
      { widget: errorRate(), ...w, bucket: "second" },
    ]) {
      const reply = await run("invalid", request);
      expect(reply.status).toBe(400);
      expect(typeof reply.json.error).toBe("string");
    }
    const missing = await run("invalid", { widget: errorRate(), from: w.from });
    expect(missing.status >= 400 && missing.status < 500).toBe(true);
  });

  test("workspace_source_narrows_unpinned_queries_only", async () => {
    const sources = await project(ctx, "Sources");
    const other = await project(ctx, "Other");
    const s2 = (await call(ctx, "POST", `/api/products/${sources.id}/sources`, { name: "iOS" }))
      .json.id;
    await seedEvents(sources.id, [
      ...many(3, (i) => ({ event_id: `a${i}`, name: "checkout_request" })),
      ...many(5, (i) => ({ event_id: `b${i}`, name: "checkout_request", source_id: s2 })),
    ]);
    const widget = {
      id: "requests",
      title: "Requests",
      view: { type: "stat" },
      queries: {
        all: { signal: "events", event: "checkout_request" },
        pinned: { signal: "events", event: "checkout_request", source_id: sources.id },
      },
      series: [{ expr: "all" }, { expr: "pinned" }],
    };
    const totals = (body: { series: { total: number }[] }) => body.series.map((s) => s.total);
    expect(totals((await run(sources.id, runBody(widget, 7, { source_id: s2 }))).json)).toEqual([
      5, 3,
    ]);
    expect(totals((await run(sources.id, runBody(widget, 7))).json)).toEqual([8, 3]);
    const wrong = await run(sources.id, runBody(widget, 7, { source_id: other.id }));
    expect(wrong.status).toBe(404);
    expect(wrong.json).toMatchObject({
      error: "Source not found",
      errors: [{ path: "/source_id" }],
    });
    expect(wrong.json.errors[0].hint).toContain("sources");
  });

  test("read_prefix_serves_schema_and_existing_queries", async () => {
    const p = await project(ctx, "Read Prefix");
    await seedEvents(
      p.id,
      many(4, (i) => ({ event_id: `e${i}`, name: "checkout_request" })),
    );
    await seedLogs(
      p.id,
      many(2, (i) => ({ log_id: `w${i}`, level: "warn" })),
    );
    const query = { ...window(7), measure: "count" };
    const managed = await call(ctx, "POST", `/api/products/${p.id}/query`, query);
    expect(managed.json.summary.total).toBe(4);
    for (const key of [p.id, "read-prefix"]) {
      const read = await call(ctx, "POST", `/api/read/products/${key}/query`, query);
      expect(read.json).toEqual(managed.json);
    }
    const logs = window(7);
    const managedLogs = await call(ctx, "POST", `/api/products/${p.id}/logs/query`, logs);
    expect(managedLogs.json.total).toBe(2);
    for (const key of [p.id, "read-prefix"]) {
      const read = await call(ctx, "POST", `/api/read/products/${key}/logs/query`, logs);
      expect(read.json).toEqual(managedLogs.json);
    }
    expect(
      (
        await call(ctx, "POST", `/api/products/${p.id}/query`, query, {
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect((await call(ctx, "POST", "/api/read/products/missing/query", query)).status).toBe(404);
  });

  test("rankings_grouped_series_and_lists_run", async () => {
    const shapes = await project(ctx, "Shapes");
    let n = 0;
    const id = () => `e${n++}`;
    const rows = [
      ...many(5, () => ({ event_id: id(), name: "signup", properties: { plan: "pro" } })),
      ...many(3, () => ({ event_id: id(), name: "signup", properties: { plan: "free" } })),
      ...many(2, () => ({ event_id: id(), name: "signup", properties: { plan: 1 } })),
      { event_id: id(), name: "signup" },
      ...many(2, () => ({ event_id: id(), name: "upgrade", properties: { plan: "pro" } })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((page) =>
        many(9 - page, () => ({ event_id: id(), name: "visit", properties: { page: `p${page}` } })),
      ),
      ...many(55, () => ({ event_id: id(), name: "tick" })),
    ];
    await seedEvents(shapes.id, rows);
    await seedLogs(
      shapes.id,
      many(3, (i) => ({ log_id: `l${i}`, service: "api" })),
    );
    const ranking = {
      id: "plans",
      title: "Plans",
      view: { type: "ranking", limit: 3 },
      queries: {
        signups: { signal: "events", event: "signup", group_by: "property:plan" },
        upgrades: { signal: "events", event: "upgrade", group_by: "property:plan" },
      },
      series: [{ expr: "signups" }, { expr: "upgrades / signups * 100" }],
    };
    const body = (await run("shapes", runBody(ranking, 7))).json;
    expect(body.series[0].total).toBe(11);
    expect(body.series[0].groups).toEqual([
      { label: "pro", value: 5 },
      { label: "free", value: 3 },
      { label: 1, value: 2 },
    ]);
    expect(body.series[1].groups).toEqual([
      { label: "pro", value: 40 },
      { label: "free", value: 0 },
      { label: 1, value: 0 },
    ]);
    const grouped = {
      id: "pages",
      title: "Pages",
      view: { type: "line" },
      queries: { visits: { signal: "events", event: "visit", group_by: "property:page" } },
    };
    const series = (await run("shapes", runBody(grouped, 7))).json.series;
    expect(series.map((s: { group: unknown }) => s.group)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    expect(
      series[0].points.reduce(
        (sum: number, p: { value: number | null }) => sum + (p.value ?? 0),
        0,
      ),
    ).toBe(8);
    const list = {
      id: "ticks",
      title: "Ticks",
      view: { type: "events" },
      queries: { ticks: { signal: "events", event: "tick" } },
    };
    const listed = (await run("shapes", runBody(list, 7))).json;
    expect(listed.series).toEqual([]);
    expect(listed.rows).toHaveLength(50);
    expect(listed.rows.every((r: { name: string }) => r.name === "tick")).toBe(true);
    const api = {
      id: "api",
      title: "API logs",
      view: { type: "logs" },
      queries: { api: { signal: "logs", service: "api" } },
    };
    const logs = (await run("shapes", runBody(api, 7))).json;
    expect(logs.rows).toHaveLength(3);
    expect(logs.rows[0].service).toBe("api");
    const text = { id: "note", title: "Note", view: { type: "text", markdown: "Hello" } };
    const note = (await run("shapes", runBody(text, 7))).json;
    expect([note.series, note.rows]).toEqual([[], null]);
  });

  test("a_full_dashboard_gate_times_out_widgets_but_not_interactive_queries", async () => {
    const busy = await project(ctx, "Busy");
    await seedEvents(
      busy.id,
      many(2, (i) => ({ event_id: `e${i}`, name: "checkout_request" })),
    );
    const widget = {
      id: "requests",
      title: "Requests",
      view: { type: "stat" },
      timeout_ms: 1000,
      queries: { requests: { signal: "events", event: "checkout_request" } },
    };
    const held = await ctx.gates.events.acquire(Date.now() + 1000, 3);
    const started = Date.now();
    const timed = await run("busy", runBody(widget, 7));
    expect(timed.status).toBe(503);
    expect(timed.json).toEqual({ error: "Timed out after 1 s", code: "query_timeout" });
    expect(timed.headers.get("retry-after")).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    const interactive = await call(ctx, "POST", "/api/read/products/busy/query", window(7));
    expect(interactive.json.summary.total).toBe(2);
    held?.();
    expect((await run("busy", runBody(widget, 7))).json.series[0].total).toBe(2);
  });

  test("catalog_lists_typed_keys_facets_retention_and_limits", async () => {
    const shop = await project(ctx, "Shop", 365);
    await seedEvents(shop.id, [
      { event_id: "a", name: "checkout", properties: { plan: "pro", amount: 12.5 } },
      { event_id: "b", name: "checkout", properties: { plan: "free", amount: 3.5 } },
      { event_id: "c", name: "signup", properties: { plan: "pro" } },
    ]);
    await seedLogs(shop.id, [
      ...many(3, (i) => ({ log_id: `c${i}`, service: "checkout" })),
      { log_id: "s", service: "search", level: "error" },
    ]);
    const body = (await call(ctx, "GET", "/api/read/products/shop/catalog")).json;
    expect(body.project).toEqual({ id: shop.id, slug: "shop", name: "Shop" });
    expect(body.events.names).toEqual(["checkout", "signup"]);
    expect(body.events.properties).toEqual([
      { key: "plan", type: "string", count: 3 },
      { key: "amount", type: "number", count: 2 },
    ]);
    expect(body.logs.services[0]).toEqual({ name: "checkout", count: 3 });
    expect(body.logs.services[1].name).toBe("search");
    expect(body.logs.levels).toEqual(["info", "error"]);
    expect(body.sources).toHaveLength(1);
    expect(body.retention).toEqual({ events_days: 365, logs_days: 7 });
    expect(body.limits.max_widgets).toBe(24);
    // Dashboards hold no SQL, so the catalog lists no tables or columns.
    expect(body.sql).toBeUndefined();
    expect(body.limits.funnel_steps).toEqual({ min: 2, max: 8 });
    expect(body.limits.retention_periods).toEqual({ min: 1, max: 12, default: 8 });
    expect((await call(ctx, "GET", `/api/read/products/${shop.id}/catalog`)).json.events).toEqual(
      body.events,
    );
    const missing = await call(ctx, "GET", "/api/read/products/missing/catalog");
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("not_found");
    const widget = (event: string) => ({
      id: "w",
      title: "W",
      view: { type: "stat" },
      queries: { a: { signal: "events", event } },
      series: [{ expr: "a" }],
    });
    const misspelt = (await run("shop", runBody(widget("checkot"), 7))).json;
    expect(misspelt.warnings).toHaveLength(1);
    expect(misspelt.warnings[0].path).toBe("/queries/a/event");
    expect(misspelt.warnings[0].hint).toContain("did you mean `checkout`");
    const real = (await run("shop", runBody(widget("checkout"), 7))).json;
    expect(real.warnings).toEqual([]);
    expect(real.series[0].total).toBe(2);
  });

  test("validate_endpoint_reports_errors_and_warnings", async () => {
    const shop = await project(ctx, "Shop");
    await seedEvents(shop.id, [{ event_id: "a", name: "checkout" }]);
    const doc = (event: string) => ({
      version: 1,
      name: "D",
      widgets: [
        {
          id: "w",
          title: "W",
          view: { type: "stat" },
          queries: { a: { signal: "events", event } },
        },
      ],
    });
    const validate = (document: unknown) =>
      call(ctx, "POST", "/api/read/products/shop/dashboards/validate", { document });
    expect((await validate(doc("checkout"))).json).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    const warned = (await validate(doc("checkot"))).json;
    expect(warned.valid).toBe(true);
    expect(warned.warnings[0].path).toBe("/widgets/0/queries/a/event");
    const broken = (await validate({ ...doc("checkout"), version: 2 })).json;
    expect(broken.valid).toBe(false);
    expect(broken.errors[0].path).toBe("/version");
  });

  test("the_overview_template_runs", async () => {
    const site = await project(ctx, "Site");
    await seedEvents(
      site.id,
      many(5, (i) => ({
        event_id: `v${i}`,
        name: "page_view",
        actor_id: `a${i % 2}`,
        identity_kind: "visitor",
        session_id: `s${i % 3}`,
        properties: { path: "/", duration_ms: 100 + i, success: true },
      })),
    );
    const template = overviewTemplate("Overview") as { widgets: unknown[] };
    for (const widget of template.widgets) {
      const reply = await run("site", runBody(widget, 7));
      expect({
        id: (widget as { id: string }).id,
        status: reply.status,
        error: reply.json.error ?? null,
      }).toEqual({
        id: (widget as { id: string }).id,
        status: 200,
        error: null,
      });
    }
  }, 60_000);
});
