import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call, project, seedEvents, seedLogs, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await testContext();
}, 300_000);

afterEach(() => ctx?.cleanup());

const DAY = 86_400_000;

function window(days: number) {
  const to = new Date(Date.now() + 60_000);
  return { from: new Date(to.getTime() - days * DAY).toISOString(), to: to.toISOString() };
}

const run = (widget: unknown, days = 7) =>
  call(ctx, "POST", "/api/read/products/shop/widgets/run", { widget, ...window(days) });

const stat = (query: unknown) => ({
  id: "w",
  title: "W",
  view: { type: "stat", compare: "none" },
  queries: { a: query },
});

async function total(query: unknown): Promise<number | null> {
  const reply = await run(stat(query));
  if (reply.status !== 200) throw new Error(JSON.stringify(reply.json));
  return reply.json.series[0].total;
}

let n = 0;
const at = (ms: number) => new Date(Date.now() - ms);

describe("richer typed queries", () => {
  test("six_lines_fit_on_one_chart", async () => {
    const shop = await project(ctx, "Shop");
    const names = ["a", "b", "c", "d", "e", "f"];
    await seedEvents(
      shop.id,
      names.map((name) => ({ event_id: `e${n++}`, name, time: at(DAY) })),
    );
    const queries = Object.fromEntries(
      names.map((name) => [name, { signal: "events", event: name }]),
    );
    const widget = {
      id: "lines",
      title: "Six lines",
      view: { type: "line" },
      queries,
      series: names.map((name) => ({ expr: name })),
    };
    const reply = await run(widget);
    expect(reply.status).toBe(200);
    expect(reply.json.series).toHaveLength(6);
    expect(reply.json.series.map((s: { total: number }) => s.total)).toEqual([1, 1, 1, 1, 1, 1]);
    const seven = { ...widget, queries: { ...queries, g: { signal: "events", event: "g" } } };
    seven.series = [...widget.series, { expr: "g" }];
    const validated = await call(ctx, "POST", "/api/read/products/shop/dashboards/validate", {
      document: { version: 1, name: "Lines", widgets: [seven] },
    });
    expect(validated.json.errors.map((e: { path: string }) => e.path)).toContain(
      "/widgets/0/queries",
    );
  });

  test("filter_ops_in_contains_and_exists", async () => {
    const shop = await project(ctx, "Shop");
    const event = (properties: Record<string, unknown>) => ({
      event_id: `e${n++}`,
      time: at(DAY),
      properties,
    });
    await seedEvents(shop.id, [
      event({ plan: "pro", title: "Checkout page" }),
      event({ plan: "team", title: "Pricing" }),
      event({ plan: "free", title: "CHECKOUT done" }),
      event({ title: "Home" }),
      event({ plan: 5 }),
    ]);
    const where = (property: string, op: string, value?: unknown) => ({
      signal: "events",
      filters: [value === undefined ? { property, op } : { property, op, value }],
    });
    expect(await total(where("plan", "in", ["pro", "team"]))).toBe(2);
    expect(await total(where("plan", "in", [5, "pro"]))).toBe(2);
    expect(await total(where("plan", "not_in", ["pro", "team"]))).toBe(2);
    expect(await total(where("title", "contains", "checkout"))).toBe(2);
    expect(await total(where("title", "not_contains", "checkout"))).toBe(2);
    expect(await total(where("plan", "exists"))).toBe(4);
    expect(await total(where("plan", "not_exists"))).toBe(1);
  });

  test("log_filters_take_ops", async () => {
    const shop = await project(ctx, "Shop");
    const log = (attributes: Record<string, unknown>) => ({
      log_id: `l${n++}`,
      time: at(60_000),
      attributes,
    });
    await seedLogs(shop.id, [
      log({ region: "eu", route: "/api/checkout" }),
      log({ region: "us", route: "/api/CHECKOUT/confirm" }),
      log({ region: "apac", route: "/api/home" }),
      log({}),
    ]);
    const where = (attribute: string, op: string, value?: unknown) => ({
      signal: "logs",
      filters: [value === undefined ? { attribute, op } : { attribute, op, value }],
    });
    expect(await total(where("region", "in", ["eu", "us"]))).toBe(2);
    expect(await total(where("route", "contains", "checkout"))).toBe(2);
    expect(await total(where("region", "not_exists"))).toBe(1);
    // Without an op a log filter is still an equality.
    expect(await total({ signal: "logs", filters: [{ attribute: "region", value: "eu" }] })).toBe(
      1,
    );
  });

  test("unique_and_sessions_count_distinct_values", async () => {
    const shop = await project(ctx, "Shop");
    const event = (country: string | null, session: string | null) => ({
      event_id: `e${n++}`,
      time: at(DAY),
      actor_id: "a",
      session_id: session,
      properties: country ? { country } : {},
    });
    await seedEvents(shop.id, [
      event("US", "s1"),
      event("US", "s1"),
      event("DE", "s2"),
      event(null, null),
    ]);
    expect(await total({ signal: "events", measure: "unique", property: "country" })).toBe(2);
    expect(await total({ signal: "events", measure: "sessions" })).toBe(2);
    await seedLogs(shop.id, [
      { log_id: `l${n++}`, attributes: { region: "eu" } },
      { log_id: `l${n++}`, attributes: { region: "eu" } },
      { log_id: `l${n++}`, attributes: { region: "us" } },
    ]);
    expect(await total({ signal: "logs", measure: "unique", attribute: "region" })).toBe(2);
  });

  test("new_and_returning_actors_split_the_actors", async () => {
    const shop = await project(ctx, "Shop");
    const event = (actor: string, ago: number) => ({
      event_id: `e${n++}`,
      time: at(ago),
      actor_id: actor,
      identity_kind: "visitor",
    });
    await seedEvents(shop.id, [event("a", 10 * DAY), event("a", 60_000), event("b", 60_000)]);
    expect(await total({ signal: "events", measure: "new_actors" })).toBe(1);
    expect(await total({ signal: "events", measure: "returning_actors" })).toBe(1);
    expect(await total({ signal: "events", measure: "actors" })).toBe(2);
    const reply = await run({
      id: "audience",
      title: "Audience",
      view: { type: "line", compare: "none", bucket: "day" },
      queries: {
        fresh: { signal: "events", measure: "new_actors" },
        back: { signal: "events", measure: "returning_actors" },
        all: { signal: "events", measure: "actors" },
      },
      series: [{ expr: "fresh" }, { expr: "back" }, { expr: "all" }],
    });
    expect(reply.status).toBe(200);
    const [fresh, back, all] = reply.json.series.map((s: { points: { value: number }[] }) =>
      s.points.map((p) => p.value),
    );
    expect(fresh.map((v: number, i: number) => v + back[i])).toEqual(all);
    expect(all.reduce((a: number, b: number) => a + b, 0)).toBe(2);
  });

  test("p90_and_p99_follow_quantile_cont", async () => {
    const shop = await project(ctx, "Shop");
    await seedEvents(
      shop.id,
      Array.from({ length: 10 }, (_, i) => ({
        event_id: `e${n++}`,
        time: at(DAY),
        properties: { ms: i + 1 },
      })),
    );
    expect(await total({ signal: "events", measure: "p90", property: "ms" })).toBeCloseTo(9.1, 9);
    expect(await total({ signal: "events", measure: "p99", property: "ms" })).toBeCloseTo(9.91, 9);
    await seedLogs(
      shop.id,
      Array.from({ length: 10 }, (_, i) => ({ log_id: `l${n++}`, attributes: { ms: i + 1 } })),
    );
    expect(await total({ signal: "logs", measure: "p90", attribute: "ms" })).toBeCloseTo(9.1, 9);
  });
});
