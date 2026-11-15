import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { call, project, seedLogs, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await testContext();
}, 300_000);

afterAll(() => ctx?.cleanup());

const DAY = 86_400_000;

async function query(id: string, extra: Record<string, unknown> = {}) {
  const body = {
    from: new Date(Date.now() - 7 * DAY).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
  const reply = await call(ctx, "POST", `/api/products/${id}/logs/query`, body);
  if (reply.status !== 200) throw new Error(`${reply.status}: ${JSON.stringify(reply.json)}`);
  return reply.json;
}

function log(id: string, extra: Record<string, unknown> = {}) {
  return {
    log_id: id,
    service: "api",
    level: "info",
    message: "Request completed",
    attributes: { status: 200, success: true, code: "200", nested: { array: [1, "two", false] } },
    ...extra,
  };
}

describe("log queries", () => {
  test("cursor_pagination_is_stable_for_equal_timestamps", async () => {
    const { id } = await project(ctx, "Pages");
    const time = new Date();
    await seedLogs(
      id,
      Array.from({ length: 150 }, (_, i) => log(`id-${String(i).padStart(3, "0")}`, { time })),
    );
    const first = await query(id);
    expect(first.logs).toHaveLength(100);
    expect(first.total).toBe(150);
    const next = await query(id, { cursor: first.next_cursor });
    expect(next.logs).toHaveLength(50);
    expect(next.next_cursor).toBeNull();
    const ids = new Set([...first.logs, ...next.logs].map((r: { log_id: string }) => r.log_id));
    expect(ids.size).toBe(150);
    expect(first.series.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(150);
    expect(first.logs[0]).toMatchObject({
      source_id: id,
      level: "info",
      message: "Request completed",
      service: "api",
      environment: null,
      attributes: { status: 200, nested: { array: [1, "two", false] } },
    });
    expect(typeof first.logs[0].timestamp).toBe("number");
  });

  test("summaries_cover_all_buckets_and_rank_services_before_pagination", async () => {
    const { id } = await project(ctx, "Summaries");
    const from = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);
    const to = new Date(from.getTime() + 3_600_000);
    await seedLogs(
      id,
      Array.from({ length: 210 }, (_, i) => ({
        log_id: `summary-${String(i).padStart(3, "0")}`,
        time: new Date(from.getTime() + (i % 60) * 60_000),
        service: `service-${String(i % 70).padStart(2, "0")}`,
        message: "Literal Needle_% completed",
        level: i % 3 === 0 ? "fatal" : "info",
        attributes: { group: i % 2 },
      })),
    );
    const body = { from: from.toISOString(), to: to.toISOString(), search: "nEeDlE_%" };
    const path = `/api/products/${id}/logs/query`;
    const first = (await call(ctx, "POST", path, body)).json;
    expect(first.total).toBe(210);
    expect(first.series).toHaveLength(60);
    first.series.forEach(
      (bucket: { time: number; count: number; errors: number }, index: number) => {
        const count = index < 30 ? 4 : 3;
        expect(bucket).toEqual({
          time: from.getTime() + index * 60_000,
          count,
          errors: index % 3 === 0 ? count : 0,
        });
      },
    );
    expect(first.services).toHaveLength(50);
    expect(first.services).toEqual(
      Array.from({ length: 50 }, (_, index) => ({
        name: `service-${String(index).padStart(2, "0")}`,
        count: 3,
      })),
    );
    const next = (await call(ctx, "POST", path, { ...body, cursor: first.next_cursor })).json;
    for (const field of ["total", "series", "services"]) expect(next[field]).toEqual(first[field]);
    expect(next.facets).toBeNull();
    const filtered = (
      await call(ctx, "POST", path, { ...body, filters: [{ attribute: "group", value: 1 }] })
    ).json;
    expect(filtered.total).toBe(105);
    const empty = (await call(ctx, "POST", path, { ...body, search: "absent" })).json;
    expect(empty.total).toBe(0);
    expect(empty.services).toEqual([]);
    expect(
      empty.series.every((b: { count: number; errors: number }) => b.count === 0 && b.errors === 0),
    ).toBe(true);
  });

  test("facets_list_every_known_service_environment_and_typed_attribute", async () => {
    const { id } = await project(ctx, "Facets");
    await seedLogs(id, [
      {
        log_id: "f-1",
        service: "api",
        environment: "production",
        message: "ok",
        attributes: { status: 200, region: "tokyo", cached: false, context: { queue: "orders" } },
      },
      {
        log_id: "f-2",
        service: "worker",
        environment: "staging",
        message: "ok",
        attributes: { status: 500, region: "osaka" },
      },
      {
        log_id: "f-3",
        service: "api",
        message: "no environment",
        attributes: { status: "200", "dotted.key": "x" },
      },
    ]);
    const result = await query(id, { service: "api", environment: "production" });
    expect(result.total).toBe(1);
    const names = (list: { name: string }[]) => list.map((item) => item.name);
    expect(names(result.facets.services)).toEqual(["api", "worker"]);
    expect(names(result.facets.environments)).toEqual(["production", "staging"]);
    const kind = (key: string) =>
      result.facets.attributes.find((item: { key: string }) => item.key === key)?.type;
    expect(kind("status")).toBe("number");
    expect(kind("region")).toBe("string");
    expect(kind("cached")).toBe("boolean");
    expect(kind("dotted.key")).toBe("string");
    expect(kind("context")).toBeUndefined();
    expect(kind("context.queue")).toBeUndefined();
  });

  test("minimum_level_includes_more_severe_levels_and_excludes_an_exact_level", async () => {
    const { id } = await project(ctx, "Levels");
    await seedLogs(
      id,
      ["trace", "debug", "info", "warn", "error", "fatal"].map((level) => ({
        log_id: `l-${level}`,
        level,
        message: "m",
      })),
    );
    expect((await query(id)).total).toBe(6);
    expect((await query(id, { min_level: "warn" })).total).toBe(3);
    expect((await query(id, { level: "warn" })).total).toBe(1);
    const both = await call(ctx, "POST", `/api/products/${id}/logs/query`, {
      from: new Date(Date.now() - DAY).toISOString(),
      to: new Date().toISOString(),
      level: "warn",
      min_level: "warn",
    });
    expect(both.json.error).toBe("Use either level or min_level, not both");
  });

  test("validation_is_atomic_and_search_preserves_scalar_types", async () => {
    const { id } = await project(ctx, "Scalars");
    await seedLogs(id, [
      log("first"),
      log("second", {
        message: "Literal 100%_done ' OR 1=1 --",
        attributes: { status: "200", success: true },
      }),
    ]);
    for (const value of [200, "200"])
      expect((await query(id, { filters: [{ attribute: "status", value }] })).total).toBe(1);
    expect((await query(id, { filters: [{ attribute: "success", value: "true" }] })).total).toBe(0);
    expect((await query(id, { filters: [{ attribute: "success", value: true }] })).total).toBe(2);
    expect((await query(id, { search: "100%_done ' OR 1=1 --" })).total).toBe(1);
  });

  test("unknown sources and bad ranges are refused", async () => {
    const { id } = await project(ctx, "Refusals");
    const path = `/api/products/${id}/logs/query`;
    const base = { from: new Date(Date.now() - DAY).toISOString(), to: new Date().toISOString() };
    const unknown = await call(ctx, "POST", path, {
      ...base,
      source_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("Source not found");
    const long = await call(ctx, "POST", path, {
      ...base,
      from: new Date(Date.now() - 32 * DAY).toISOString(),
    });
    expect(long.json.error).toBe("Log query range must be positive and at most 31 days");
    expect((await call(ctx, "POST", path, { ...base, level: "loud" })).json.error).toBe(
      "Invalid log level",
    );
    expect(
      (await call(ctx, "POST", path, { ...base, cursor: { timestamp: 0, log_id: "x" } })).json
        .error,
    ).toBe("Invalid log cursor");
    expect(
      (await call(ctx, "POST", path, { ...base, filters: [{ attribute: "a", value: { no: 1 } }] }))
        .json.error,
    ).toBe("Provide at most eight typed scalar attribute filters");
  });
});
