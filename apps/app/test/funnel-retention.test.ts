import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call, project, seedEvents, type TestContext, testContext } from "./helpers";

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

const run = (key: string, widget: unknown, days = 7) =>
  call(ctx, "POST", `/api/read/products/${key}/widgets/run`, { widget, ...window(days) });

const step = (event: string) => ({ event });

function funnel(steps: string[], extra: Record<string, unknown> = {}) {
  return {
    id: "funnel",
    title: "Checkout funnel",
    view: { type: "ranking" },
    queries: { f: { signal: "funnel", steps: steps.map(step), ...extra } },
  };
}

let n = 0;
const event = (actor: string, name: string, time: Date) => ({
  event_id: `e${n++}`,
  name,
  time,
  actor_id: actor,
  identity_kind: "visitor",
});

/** Monday 00:00 UTC of the week holding `at`. */
function monday(at: Date): number {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY;
}

describe("funnels", () => {
  test("a_funnel_counts_actors_reaching_each_step_in_order", async () => {
    const shop = await project(ctx, "Shop");
    const t = new Date(Date.now() - 2 * DAY);
    const at = (hours: number) => new Date(t.getTime() + hours * HOUR);
    await seedEvents(shop.id, [
      event("a", "visit", at(0)),
      event("a", "signup", at(1)),
      event("a", "buy", at(2)),
      event("b", "visit", at(0)),
      event("b", "signup", at(3)),
      event("c", "signup", at(1)),
    ]);
    const reply = await run("shop", funnel(["visit", "signup", "buy"]));
    expect(reply.status).toBe(200);
    expect(reply.json.series[0].groups).toEqual([
      { label: "visit", value: 2 },
      { label: "signup", value: 2 },
      { label: "buy", value: 1 },
    ]);
    // Formulas see the funnel's total, its last step.
    expect(reply.json.series[0].total).toBe(1);
  });

  test("the_funnel_window_bounds_conversion", async () => {
    const shop = await project(ctx, "Shop");
    const t = new Date(Date.now() - 2 * DAY);
    await seedEvents(shop.id, [
      event("a", "visit", t),
      event("a", "signup", new Date(t.getTime() + 2 * HOUR)),
      event("b", "visit", t),
      event("b", "signup", new Date(t.getTime() + 30 * 60_000)),
    ]);
    const reply = await run("shop", funnel(["visit", "signup"], { window: "1h" }));
    expect(reply.status).toBe(200);
    expect(reply.json.series[0].groups).toEqual([
      { label: "visit", value: 2 },
      { label: "signup", value: 1 },
    ]);
  });

  test("funnels_count_sessions_label_repeated_steps_and_filter_steps", async () => {
    const shop = await project(ctx, "Shop");
    const t = new Date(Date.now() - 2 * DAY);
    const at = (minutes: number) => new Date(t.getTime() + minutes * 60_000);
    const hit = (session: string, name: string, minutes: number, plan?: string) => ({
      ...event("a", name, at(minutes)),
      session_id: session,
      properties: plan ? { plan } : {},
    });
    await seedEvents(shop.id, [
      hit("s1", "visit", 0),
      hit("s1", "pricing", 1, "pro"),
      hit("s1", "visit", 2),
      hit("s2", "visit", 10),
      hit("s2", "pricing", 11, "free"),
      hit("s2", "visit", 12),
    ]);
    const widget = funnel([], { by: "session" });
    widget.queries.f.steps = [
      { event: "visit" },
      { event: "pricing", filters: [{ property: "plan", op: "eq", value: "pro" }] },
      { event: "visit" },
    ] as never;
    const reply = await run("shop", widget);
    expect(reply.status).toBe(200);
    expect(reply.json.series[0].groups).toEqual([
      { label: "visit (1)", value: 2 },
      { label: "pricing", value: 1 },
      { label: "visit (3)", value: 1 },
    ]);
  });

  test("a_funnel_table_shows_conversion_from_the_first_and_previous_step", async () => {
    const shop = await project(ctx, "Shop");
    const t = new Date(Date.now() - 2 * DAY);
    const at = (hours: number) => new Date(t.getTime() + hours * HOUR);
    await seedEvents(shop.id, [
      event("a", "visit", at(0)),
      event("a", "signup", at(1)),
      event("b", "visit", at(0)),
      event("b", "signup", at(1)),
      event("b", "buy", at(2)),
      event("c", "visit", at(0)),
      event("d", "visit", at(0)),
    ]);
    const widget = { ...funnel(["visit", "signup", "buy"]), view: { type: "table" } };
    const reply = await run("shop", widget);
    expect(reply.status).toBe(200);
    expect(reply.json.series).toEqual([]);
    expect(reply.json.columns).toEqual([
      { name: "step", type: "String" },
      { name: "actors", type: "UInt64" },
      { name: "conversion", type: "Float64", unit: "ratio" },
      { name: "from_previous", type: "Float64", unit: "ratio" },
    ]);
    expect(reply.json.rows).toEqual([
      ["visit", 4, 1, 1],
      ["signup", 2, 0.5, 0.5],
      ["buy", 1, 0.25, 0.5],
    ]);
  });
});

describe("retention", () => {
  test("retention_groups_cohorts_by_first_start_event", async () => {
    const shop = await project(ctx, "Shop");
    const now = new Date();
    const thisWeek = monday(now);
    const lastWeek = thisWeek - 7 * DAY;
    const tuesday = new Date(lastWeek + DAY + HOUR);
    const recent = new Date(now.getTime() - 1_000);
    await seedEvents(shop.id, [
      event("a", "signup", tuesday),
      event("a", "signup", new Date(tuesday.getTime() + HOUR)),
      event("a", "page_view", recent),
      event("b", "signup", tuesday),
      event("b", "page_view", new Date(tuesday.getTime() + HOUR)),
      event("c", "signup", recent),
      event("d", "page_view", recent),
    ]);
    const widget = {
      id: "retention",
      title: "Weekly retention",
      view: { type: "table" },
      range: "28d",
      queries: {
        r: {
          signal: "retention",
          start: { event: "signup" },
          return: { event: "page_view" },
          period: "week",
          periods: 2,
        },
      },
    };
    const reply = await run("shop", widget);
    expect(reply.status).toBe(200);
    expect(reply.json.columns).toEqual([
      // A cohort is a UTC calendar period, so it is a date wherever the viewer is.
      { name: "cohort", type: "Date" },
      { name: "size", type: "UInt64" },
      { name: "p0", type: "Float64", unit: "ratio" },
      { name: "p1", type: "Float64", unit: "ratio" },
      { name: "p2", type: "Float64", unit: "ratio" },
    ]);
    // Periods that have not started by the range's end have no value yet.
    expect(reply.json.rows).toEqual([
      [lastWeek, 2, 1, 0.5, null],
      [thisWeek, 1, 1, null, null],
    ]);
  });
});

describe("no SQL in dashboards", () => {
  test("sql_queries_are_refused_with_a_pointer", async () => {
    await project(ctx, "Shop");
    const widget = {
      id: "w",
      title: "W",
      view: { type: "stat" },
      queries: { a: { signal: "sql", database: "events", sql: "SELECT 1 AS value" } },
    };
    const reply = await call(ctx, "POST", "/api/read/products/shop/dashboards/validate", {
      document: { version: 1, name: "SQL", widgets: [widget] },
    });
    expect(reply.status).toBe(200);
    expect(reply.json.valid).toBe(false);
    expect(reply.json.errors[0].path).toBe("/widgets/0/queries/a/signal");
    expect(reply.json.errors[0].message).toStartWith("unknown variant `sql`");
  });
});

function views(id: string, event: string) {
  return {
    id,
    title: id,
    view: { type: "stat" },
    queries: { q: { signal: "events", event, measure: "count" } },
    series: [{ expr: "q" }],
  };
}
const board = (name: string, widgets: unknown[]) => ({ version: 1, name, widgets });
const path = (id: string) => `/api/products/${id}/dashboards`;
const put = (id: string, key: string, base: number, doc: unknown) =>
  call(ctx, "PUT", `${path(id)}/${key}`, { base_revision: base, document: doc });

describe("benchmarks before saving", () => {
  test("a_fast_widget_saves_and_reports_its_bench", async () => {
    const shop = await project(ctx, "Shop");
    await seedEvents(shop.id, [{ event_id: "x1" }, { event_id: "x2" }]);
    const reply = await call(ctx, "POST", path(shop.id), {
      document: board("Board", [views("views", "page_view")]),
    });
    expect(reply.status).toBe(200);
    expect(reply.json.revision).toBe(1);
    expect(reply.json.bench).toHaveLength(1);
    expect(reply.json.bench[0].widget).toBe("views");
    expect(reply.json.bench[0].elapsed_ms).toBeLessThan(1_000);
    expect(reply.json.warnings).toEqual([]);
  });

  test("unchanged_widgets_are_not_benched_again", async () => {
    const shop = await project(ctx, "Shop");
    const created = await call(ctx, "POST", path(shop.id), {
      document: board("Board", [views("a", "x"), views("b", "y")]),
    });
    expect(created.status).toBe(200);
    expect(created.json.bench).toHaveLength(2);
    const renamed = await put(
      shop.id,
      "board",
      1,
      board("Renamed", [views("a", "x"), views("b", "y")]),
    );
    expect(renamed.status).toBe(200);
    expect(renamed.json.bench).toEqual([]);
    const edited = await put(
      shop.id,
      "board",
      2,
      board("Renamed", [views("a", "x"), views("b", "z")]),
    );
    expect(edited.status).toBe(200);
    expect(edited.json.bench.map((b: { widget: string }) => b.widget)).toEqual(["b"]);
    const restored = await call(ctx, "POST", `${path(shop.id)}/board/revisions/1/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json.bench.map((b: { widget: string }) => b.widget)).toEqual(["b"]);
  });

  test("a_run_warning_reaches_a_successful_save_under_the_widget", async () => {
    const shop = await project(ctx, "Shop");
    const reply = await call(ctx, "POST", path(shop.id), {
      document: board("Warn", [views("a", "never_seen")]),
    });
    expect(reply.status).toBe(200);
    expect(reply.json.warnings.length).toBeGreaterThan(0);
    for (const warning of reply.json.warnings) expect(warning.path).toStartWith("/widgets/0/");
  });

  test("a_stale_put_conflicts_before_any_benchmark_runs", async () => {
    const shop = await project(ctx, "Shop");
    await call(ctx, "POST", path(shop.id), { document: board("Board", [views("views", "x")]) });
    // A benchmark would wait out this held gate; a conflict answers at once.
    const held = await ctx.gates.events.acquire(Date.now() + 1_000, 3);
    const changed = board("Board", [{ ...views("views", "other"), timeout_ms: 5_000 }]);
    const started = Date.now();
    const reply = await put(shop.id, "board", 7, changed);
    expect(reply.status).toBe(409);
    expect(reply.json.code).toBe("revision_conflict");
    expect(reply.json.revision).toBe(1);
    expect(reply.json.bench).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(900);
    held?.();
  });

  test("waiting_for_a_busy_gate_is_busy_not_too_slow", async () => {
    const shop = await project(ctx, "Shop");
    const held = await ctx.gates.events.acquire(Date.now() + 1_000, 3);
    expect(held).not.toBeNull();
    const reply = await call(ctx, "POST", path(shop.id), {
      document: board("Busy", [{ ...views("a", "x"), timeout_ms: 1_000 }]),
    });
    expect(reply.status).toBe(503);
    expect(reply.json.code).toBe("busy");
    expect(reply.json.errors[0]).toEqual({
      path: "/widgets/0",
      message: "Highkey was busy running other queries",
      hint: "Retry the save in a few seconds",
    });
    expect(reply.headers.get("retry-after")).not.toBeNull();
    held?.();
    const list = await call(ctx, "GET", "/api/read/products/shop/dashboards");
    expect(list.json).toEqual([]);
    const again = await call(ctx, "POST", path(shop.id), {
      document: board("Busy", [views("a", "x")]),
    });
    expect(again.status).toBe(200);
  });
});
