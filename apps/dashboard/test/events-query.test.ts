import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { call, project, seedEvents, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await testContext();
}, 300_000);

afterAll(() => ctx?.cleanup());

const DAY = 86_400_000;

function range(extra: Record<string, unknown> = {}) {
  return {
    from: new Date(Date.now() - 7 * DAY).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    measure: "count",
    ...extra,
  };
}

const run = async (id: string, body: unknown) =>
  call(ctx, "POST", `/api/products/${id}/query`, body);

function command(id: string, duration: unknown, extra: Record<string, unknown> = {}) {
  return {
    event_id: id,
    name: "command_run",
    source: "cli",
    actor_id: "anonymous-install",
    identity_kind: "installation",
    properties: { duration_ms: duration, success: true, command: "build" },
    ...extra,
  };
}

describe("Explore queries", () => {
  test("durable_deduplicated_scoped_typed_queries", async () => {
    const a = await project(ctx, "A");
    const b = await project(ctx, "B");
    await seedEvents(a.id, [command("one", 10), command("two", 30), command("text", "1000")]);
    await seedEvents(b.id, [command("one", 90)]);
    const avg = await run(a.id, range({ measure: "avg", property: "duration_ms", page_size: 1 }));
    expect(avg.status).toBe(200);
    expect(avg.json.summary).toMatchObject({ total: 3, value: 20, installations: 1, visitors: 0 });
    expect(avg.json.events).toHaveLength(1);
    expect(avg.json.timezone).toBe("UTC");
    expect(
      (await run(a.id, range({ measure: "sum", property: "duration_ms" }))).json.summary.value,
    ).toBe(40);
    expect(
      (await run(a.id, range({ measure: "p95", property: "duration_ms" }))).json.summary.value,
    ).toBe(29);
    const filtered = await run(
      a.id,
      range({ filters: [{ property: "duration_ms", op: "gt", value: 15 }] }),
    );
    expect(filtered.json.summary.total).toBe(1);
    expect((await run(b.id, range())).json.summary.total).toBe(1);
    const text = await run(
      a.id,
      range({ filters: [{ property: "duration_ms", op: "eq", value: "1000" }] }),
    );
    expect(text.json.summary.total).toBe(1);
    const page = await run(a.id, range({ page_size: 3 }));
    const event = page.json.events.find((e: { event_id: string }) => e.event_id === "one");
    expect(event).toMatchObject({
      event_id: "one",
      name: "command_run",
      source: "cli",
      source_id: a.id,
      actor_id: "anonymous-install",
      identity_kind: "installation",
      session_id: null,
      properties: { duration_ms: 10, success: true, command: "build" },
    });
    expect(typeof event.timestamp).toBe("number");
    expect(page.json.event_names).toEqual(["command_run"]);
  });

  test("multiple_sources_share_a_project_but_keys_and_filters_are_scoped", async () => {
    const { id } = await project(ctx, "Multi-source");
    const mobile = (await call(ctx, "POST", `/api/products/${id}/sources`, { name: "iOS" })).json
      .id;
    await seedEvents(id, [command("cli-1", 10), command("mobile-1", 20, { source_id: mobile })]);
    const q = range({ measure: "sum", property: "duration_ms", group_by: "source_id" });
    const all = await run(id, q);
    expect(all.json.summary).toMatchObject({ total: 2, value: 30 });
    expect(all.json.groups).toHaveLength(2);
    expect(all.json.groups.map((g: { label: string }) => g.label).sort()).toEqual(
      [id, mobile].sort(),
    );
    const filtered = await run(id, { ...q, source_id: mobile });
    expect(filtered.json.summary).toMatchObject({ total: 1, value: 20 });
    expect(filtered.json.events[0].source_id).toBe(mobile);
    const unknown = await run(id, range({ source_id: "00000000-0000-0000-0000-000000000000" }));
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("Source not found");
    const other = await project(ctx, "Other");
    expect((await run(other.id, { ...q, source_id: mobile })).status).toBe(404);
    expect((await run("00000000-0000-7000-8000-000000000000", range())).json.error).toBe(
      "Project not found",
    );
  });

  test("visitor_and_installation_ids_do_not_collapse", async () => {
    const { id } = await project(ctx, "Mixed");
    await seedEvents(id, [
      command("web", 1, { identity_kind: "visitor", source: "browser", session_id: "session" }),
      command("cli", 2),
    ]);
    const result = await run(id, range());
    expect(result.json.summary).toMatchObject({
      actors: 2,
      sessions: 1,
      visitors: 1,
      installations: 1,
      session_views: 1,
    });
  });

  test("retention_is_product_specific_and_uses_event_time", async () => {
    const short = await project(ctx, "Short", 30);
    const long = await project(ctx, "Long", 30);
    for (const { id } of [short, long])
      await seedEvents(id, [command("old", 5, { time: new Date(Date.now() - 3 * DAY) })]);
    await call(ctx, "PATCH", `/api/products/${short.id}`, { name: "Short", retention_days: 1 });
    await call(ctx, "POST", "/api/cleanup", {});
    expect((await run(short.id, range())).json.summary.total).toBe(0);
    expect((await run(long.id, range())).json.summary.total).toBe(1);
  }, 60_000);

  test("mixed_integer_and_float_property_values_aggregate_as_numbers", async () => {
    const { id } = await project(ctx, "Mixed numbers");
    await seedEvents(id, [
      { event_id: "a", properties: { amount: 1 } },
      { event_id: "b", properties: { amount: 2 } },
      { event_id: "c", properties: { amount: 1.5 } },
      { event_id: "d", properties: { amount: "9" } },
    ]);
    const value = async (measure: string) =>
      (await run(id, range({ measure, property: "amount" }))).json.summary.value;
    expect(await value("sum")).toBe(4.5);
    expect(await value("avg")).toBe(1.5);
    expect(await value("p50")).toBe(1.5);
    expect(await value("p95")).toBeCloseTo(1.95, 10);
    expect(await value("min")).toBe(1);
    expect(await value("max")).toBe(2);
    const greater = await run(id, range({ filters: [{ property: "amount", op: "gt", value: 1 }] }));
    expect(greater.json.summary.total).toBe(2);
  });

  test("dotted property keys filter and group", async () => {
    const { id } = await project(ctx, "Dotted");
    await seedEvents(id, [
      { event_id: "a", properties: { "utm.source": "newsletter" } },
      { event_id: "b", properties: { "utm.source": "ads" } },
      { event_id: "c", properties: { "utm.source": "ads", flag: true } },
    ]);
    const eq = await run(
      id,
      range({ filters: [{ property: "utm.source", op: "eq", value: "ads" }] }),
    );
    expect(eq.json.summary.total).toBe(2);
    const ne = await run(
      id,
      range({ filters: [{ property: "utm.source", op: "ne", value: "ads" }] }),
    );
    expect(ne.json.summary.total).toBe(1);
    const flag = await run(id, range({ filters: [{ property: "flag", op: "eq", value: true }] }));
    expect(flag.json.summary.total).toBe(1);
    const grouped = await run(id, range({ group_by: "property:utm.source" }));
    expect(grouped.json.groups).toEqual([
      { label: "ads", value: 2, count: 2 },
      { label: "newsletter", value: 1, count: 1 },
    ]);
    expect(
      grouped.json.events.find((e: { event_id: string }) => e.event_id === "a").properties,
    ).toEqual({
      "utm.source": "newsletter",
    });
  });

  test("calendar_buckets_preserve_boundaries_types_and_distinct_actors", async () => {
    const { id } = await project(ctx, "Calendar", 3650);
    const rows: [string, unknown, string][] = [
      ["2024-01-30T23:59:59.999Z", 1000, "outside"],
      ["2024-01-31T23:59:59.999Z", 10, "one"],
      ["2024-02-01T09:00:00+09:00", 30, "one"],
      ["2024-02-29T23:59:59.999Z", 50, "two"],
      ["2024-03-01T00:00:00Z", "1000", "two"],
      ["2024-04-01T00:00:00Z", 90, "outside"],
    ];
    await seedEvents(
      id,
      rows.map(([time, duration, actor], index) => ({
        event_id: String(index),
        name: "command_run",
        source: "cli",
        time: new Date(time),
        actor_id: actor,
        identity_kind: "installation",
        properties: { duration_ms: duration },
      })),
    );
    const query = (bucket: string, measure: string, extra: Record<string, unknown> = {}) =>
      run(id, {
        from: "2024-01-31T00:00:00Z",
        to: "2024-04-01T00:00:00Z",
        bucket,
        measure,
        property: "duration_ms",
        ...extra,
      });
    const point = (time: string, value: number | null) => ({ time: Date.parse(time), value });
    const count = await query("month", "count");
    expect(count.json.summary.total).toBe(4);
    expect(count.json.series).toEqual([
      point("2024-01-01T00:00:00Z", 1),
      point("2024-02-01T00:00:00Z", 2),
      point("2024-03-01T00:00:00Z", 1),
    ]);
    const avg = await query("month", "avg");
    expect(avg.json.series[1].value).toBe(40);
    expect(avg.json.series[2].value).toBeNull();
    expect((await query("month", "p95")).json.series[1].value).toBe(49);
    const actors = (await query("week", "actors")).json.series;
    expect(actors).toHaveLength(9);
    expect(actors[0]).toEqual(point("2024-01-29T00:00:00Z", 1));
    expect(actors[1].value).toBe(0);
    expect(actors[4]).toEqual(point("2024-02-26T00:00:00Z", 1));
    const weekly = (await query("week", "avg")).json.series;
    expect(weekly[0].value).toBe(20);
    expect(weekly[1].value).toBeNull();
    const empty = await run(id, {
      from: "2023-12-31T00:00:00Z",
      to: "2024-01-09T00:00:00Z",
      bucket: "week",
      measure: "count",
    });
    expect(empty.json.series).toEqual([
      point("2023-12-25T00:00:00Z", 0),
      point("2024-01-01T00:00:00Z", 0),
      point("2024-01-08T00:00:00Z", 0),
    ]);
    const filtered = await query("month", "count", {
      filters: [{ property: "duration_ms", op: "gt", value: 20 }],
    });
    expect(filtered.json.series.map((p: { value: number }) => p.value)).toEqual([0, 2, 0]);
    for (const bucket of ["quarter", "month'); DROP TABLE events; --"])
      expect((await query(bucket, "count")).status).toBe(400);
  });

  test("range limits and measures are validated", async () => {
    const { id } = await project(ctx, "Limits");
    const at = (days: number, bucket: string, extra = 0) => ({
      from: "2026-01-01T00:00:00Z",
      to: new Date(Date.parse("2026-01-01T00:00:00Z") + days * DAY + extra).toISOString(),
      bucket,
    });
    for (const [bucket, days] of [
      ["day", 366],
      ["hour", 31],
    ] as const) {
      expect((await run(id, at(days, bucket))).status).toBe(200);
      expect((await run(id, at(days, bucket, 1))).json.error).toBe(
        "Use hour/day/week/month buckets, a positive range ≤366 days (hourly ≤31 days), page ≤10000, page_size 1–100, and ≤8 filters",
      );
    }
    expect((await run(id, { ...at(1, "day"), measure: "min" })).json.error).toBe(
      "Numeric measures need a property",
    );
    expect((await run(id, { ...at(1, "day"), measure: "median" })).json.error).toBe(
      "Unsupported measure",
    );
    expect((await run(id, { ...at(1, "day"), group_by: "nope" })).status).toBe(400);
    expect(
      (await run(id, { ...at(1, "day"), filters: [{ property: "x", op: "gt", value: "a" }] })).json
        .error,
    ).toBe("Ordered comparisons require numbers; eq/ne require scalar values");
    expect((await run(id, { ...at(1, "day"), extra: 1 })).status).toBe(422);
  });
});
