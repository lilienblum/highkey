import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
test("web KPIs use distinct whole visits, exact refund-aware cents and a separate comparison window", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      t = Date.now() - 300000;
    const row = (n: number, v: string, offset: number, revenue?: number) => ({
      event_id: `m${n}`,
      name: "page_view",
      actor_id: v,
      identity_kind: "visitor",
      session_id: "same",
      time: new Date(t + offset),
      properties: revenue === undefined ? {} : { revenue },
    });
    await seedEvents(p.id, [
      row(0, "old", -1000, 300),
      row(1, "a", 0, 9007199254740991),
      row(2, "a", 1000, 9007199254740991),
      row(3, "b", 2000, -10),
    ]);
    const got = await call(ctx, "POST", `/api/products/${p.id}/web-metrics`, {
      from: new Date(t).toISOString(),
      to: new Date(t + 120000).toISOString(),
      bucket: "minute",
    });
    expect(got.status, JSON.stringify(got.json)).toBe(200);
    expect(got.json.current).toEqual({
      visitors: 2,
      sessions: 2,
      page_views: 3,
      pages_per_session: 1.5,
      bounce_rate: 50,
      session_duration: 0.5,
      revenue: "18014398509481972",
    });
    expect(got.json.previous).toMatchObject({
      sessions: 1,
      page_views: 1,
      revenue: "300",
      bounce_rate: 100,
    });
    expect(
      got.json.series.reduce((n: bigint, v: { revenue: string }) => n + BigInt(v.revenue), 0n),
    ).toBe(18014398509481972n);
  } finally {
    ctx.cleanup();
  }
});
