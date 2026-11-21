import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
test("AI traces are chronological, source-scoped and distinguish missing or invalid costs from zero", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx);
    const src = (await call(ctx, "POST", `/api/products/${p.id}/sources`, { name: "Other" })).json
      .id;
    const t = Date.now() - 5000;
    await seedEvents(
      p.id,
      [
        { properties: { cost: 0, currency: "USD", model: "a", feature: "search", trace_id: "t" } },
        { properties: { cost: 0.002, currency: "USD", model: "b", trace_id: "t", error: true } },
        { properties: { cost: "5", currency: "USD" } },
        { properties: { cost: 22, currency: "EUR" } },
        { properties: { cost: 20, currency: "USD", trace_id: "t" }, source_id: src },
      ].map((r, i) => ({
        event_id: `g${i}`,
        time: new Date(t + i),
        name: "ai_generation",
        profile_id: i < 2 ? "buyer" : undefined,
        ...r,
      })),
    );
    const report = async (q: object) => {
      const r = await call(ctx, "POST", `/api/read/products/${p.id}/ai/generations`, {
        from: new Date(t - 1).toISOString(),
        to: new Date(t + 10000).toISOString(),
        source_id: p.id,
        ...q,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    const result = await report({ group_by: "profile" });
    expect(result).toMatchObject({ priced: 2, calls: 4, cost_usd: 0.002, errors: 1 });
    expect(result.groups).toEqual([
      { label: "buyer", priced: 2, calls: 2, cost_usd: 0.002 },
      { label: null, priced: 0, calls: 2, cost_usd: null },
    ]);
    const trace = await report({ trace_id: "t", page_size: 1, page: 2 });
    expect(trace.rows).toMatchObject([{ id: "g1", model: "b", error: true }]);
  } finally {
    ctx.cleanup();
  }
}, 30000);
