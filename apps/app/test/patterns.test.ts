import { expect, test } from "bun:test";
import { call, project, seedEvents, testContext } from "./helpers";

test("weekly activity, bounded paths and distributions keep source/visitor sessions separate", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx);
    const src = (await call(ctx, "POST", `/api/products/${p.id}/sources`, { name: "Other" })).json
      .id;
    const dt = new Date();
    dt.setUTCHours(12, 0, 0, 0);
    dt.setUTCDate(dt.getUTCDate() - 1);
    const rows = (source_id: string, actor: string, pages: string[]) =>
      pages.map((path, i) => ({
        source_id,
        actor_id: actor,
        identity_kind: "visitor",
        session_id: "reused",
        event_id: `${source_id}-${actor}-${i}`,
        name: "page_view",
        time: new Date(+dt + i * 1000),
        properties: { path },
      }));
    await seedEvents(p.id, [
      ...rows(p.id, "alice", ["/", "/docs", "/api", "/done"]),
      ...rows(src, "alice", ["/foreign", "/done"]),
      ...rows(p.id, "bob", ["/"]),
    ]);
    const range = {
      from: dt.toISOString(),
      to: new Date(+dt + 60000).toISOString(),
      source_id: p.id,
    };
    const report = async (mode: string, extra: object = {}) => {
      const r = await call(ctx, "POST", `/api/read/products/${p.id}/patterns`, {
        ...range,
        mode,
        ...extra,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    const week = await report("weekly");
    expect(week.cells).toHaveLength(168);
    expect(week.cells.filter((c: { sessions: number }) => c.sessions > 0)).toEqual([
      {
        weekday: dt.getUTCDay() || 7,
        hour: 12,
        sessions: 2,
        visitors: 2,
        bounce_rate: 50,
        duration_ms: 1500,
      },
    ]);
    const flow = (extra: object) => report("flow", extra);
    expect((await flow({ steps: 2, end_path: "/done" })).paths).toEqual([
      { pages: ["/api", "/done"], sessions: 1 },
    ]);
    expect((await flow({ steps: 3, start_path: "/docs", end_path: "/done" })).total).toBe(1);
    expect((await flow({ steps: 2, start_path: "/docs", end_path: "/done" })).total).toBe(0);
    const dist = await report("distribution");
    expect(dist.buckets.map((b: { actors: number }) => b.actors)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(
      (
        await report("weekly", { filters: [{ property: "path", op: "eq", value: "/api" }] })
      ).cells.filter((c: { sessions: number }) => c.sessions > 0)[0].bounce_rate,
    ).toBe(0);
  } finally {
    ctx.cleanup();
  }
}, 30000);
