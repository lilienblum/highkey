import { test, expect } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
test("page reports count next-page time across the range boundary, exact money, trend, and pre-search shares", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      t = Date.now() - 120000;
    const row = (
      id: string,
      i: number,
      path: string,
      actor: string,
      name = "page_view",
      cents?: number,
    ) => ({
      event_id: id,
      name,
      actor_id: actor,
      identity_kind: "visitor",
      session_id: "reused",
      time: new Date(t + i),
      properties: { path, ...(cents == null ? {} : { revenue: cents }) },
    });
    await seedEvents(p.id, [
      row("prior", -1000, "/a", "p"),
      row("entry", 0, "/a", "v"),
      row("middle", 10000, "/b", "v"),
      row("exit", 31000, "/c", "v"),
      row("bounce", 100, "/a", "x"),
      row("sale", 500, "/a", "v", "sale", 9007199254740991),
    ]);
    const get = async (dimension: string, extra: object = {}) => {
      const r = await call(ctx, "POST", `/api/products/${p.id}/breakdown`, {
        from: new Date(t).toISOString(),
        to: new Date(t + 30000).toISOString(),
        dimension,
        ...extra,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    const report = await get("property:path", { search: "/a" });
    expect(report.rows[0]).toMatchObject({
      label: "/a",
      volume: 2,
      prior: 1,
      change: 100,
      entries: 2,
      exits: 1,
      bounce_rate: 50,
      time_ms: 10000,
      cents: "9007199254740991",
    });
    expect(report.rows[0].share).toBeCloseTo(2 / 3);
    expect(report.rows[0].trend.reduce((a: number, b: number) => a + b, 0)).toBe(2);
    expect(
      (await get("property:path", { sort: "label", page: 2, page_size: 1 })).rows[0],
    ).toMatchObject({ label: "/b", time_ms: 21000, exits: 0, bounce_rate: null });
    expect((await get("name", { sort: "revenue" })).rows[0].label).toBe("sale");
  } finally {
    ctx.cleanup();
  }
}, 30000);
