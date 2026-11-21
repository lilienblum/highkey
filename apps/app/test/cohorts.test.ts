import { test, expect } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
import { refreshDueCohorts } from "../src/server/cohorts";
test("cohorts qualify known profiles with zero counts, combine traits and events, publish atomically and refresh on schedule", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      root = `/api/products/${p.id}`,
      base = Date.now() - 120000,
      at = new Date(base).toISOString().slice(0, 19).replace("T", " ");
    await ctx.admin.insert(
      "highkey.events",
      ["a", "b", "c"].map((id) => ({
        product_id: p.id,
        source_id: p.id,
        profile_id: id,
        name: "identify",
        record_type: "identify",
        source: "cli",
        event_id: "identify" + id,
        event_time: at,
        received_at: at,
        expires_at: "2030-01-01 00:00:00",
        traits: { plan: id === "b" ? "basic" : "pro" },
        properties: {},
      })),
    );
    await seedEvents(p.id, [
      { event_id: "seen", name: "seen", profile_id: "a", time: new Date(base) },
    ]);
    const save = async (name: string, definition: object) => {
      const r = await call(ctx, "POST", root + "/cohorts", { name, definition });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.id as string;
    };
    const dynamic = await save("Pro without launches", {
      mode: "dynamic",
      match: "all",
      rules: [
        { event: "launch", days: 7, compare: "at_most", count: 0 },
        { property: "plan", op: "eq", value: "pro" },
      ],
    });
    const fixed = await save("Guests", { mode: "static", members: ["a", "a", "b"] });
    const cohorts = async () => (await call(ctx, "GET", root + "/cohorts")).json;
    expect((await cohorts()).map((r: { member_count: number }) => r.member_count)).toEqual([2, 2]);
    const range = {
      from: new Date(base - 1000).toISOString(),
      to: new Date(Date.now() + 1000).toISOString(),
    };
    const list = await call(ctx, "POST", root + "/people/query", { ...range, cohort: dynamic });
    expect(list.json.rows.map((r: { id: string }) => r.id).sort()).toEqual(["a", "c"]);
    const events = (
      await call(ctx, "POST", root + "/query", {
        ...range,
        filters: [{ property: `cohort.${dynamic}`, op: "eq", value: true }],
      })
    ).json;
    expect(events.summary.total).toBe(1);
    const detail = (await call(ctx, "POST", root + "/people/detail", { ...range, id: "a" })).json;
    expect(detail.cohorts.map((v: { id: string }) => v.id).sort()).toEqual([fixed, dynamic].sort());
    await seedEvents(p.id, [{ event_id: "again", name: "launch", profile_id: "a" }]);
    ctx.now = () => new Date(Date.now() + 1800001);
    await refreshDueCohorts(ctx);
    expect((await cohorts()).find((c: { id: string }) => c.id === dynamic).member_count).toBe(1);
    expect((await call(ctx, "DELETE", root + "/cohorts/" + fixed)).status).toBe(204);
  } finally {
    ctx.cleanup();
  }
}, 30000);
