import { test, expect } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
test("ordered paths, per-period conversion and weighted retention use each actor once and leave future cells empty", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      day = 86400000,
      t = Date.UTC(2026, 9, 1),
      range = { from: new Date(t).toISOString(), to: new Date(t + 3 * day).toISOString() };
    const row = (
      event_id: string,
      actor_id: string,
      name: string,
      offset: number,
      plan = "pro",
    ) => ({
      event_id,
      actor_id,
      identity_kind: "visitor",
      profile_id: actor_id,
      name,
      time: new Date(t + offset),
      properties: { plan },
      groups: { team: "shared" },
    });
    await seedEvents(p.id, [
      row("1", "a", "start", 1),
      row("2", "a", "paid", 1001),
      row("3", "a", "return", 2 * day),
      row("4", "b", "paid", 3000, "free"),
      row("5", "b", "start", 4000, "free"),
      row("6", "c", "invited", 2 * day + 1),
    ]);
    const run = async (spec: object, extra: object = {}) => {
      const r = await call(ctx, "POST", `/api/products/${p.id}/analysis`, {
        ...range,
        spec,
        ...extra,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    const funnel = { mode: "funnel", steps: ["start", "paid"], breakdown: "plan" };
    const f = await run(funnel);
    expect(f.levels).toEqual([2, 1]);
    expect(f.mean).toBe(1000);
    expect(f.quantiles).toEqual(Array(6).fill(1000));
    expect(
      (await run(funnel, { step: 1, drop: true })).rows.map((r: { profile: string }) => r.profile),
    ).toEqual(["b"]);
    const c = await run({ ...funnel, mode: "conversion" });
    expect(c.lines.find((l: { label: string }) => l.label === "pro").average).toBe(1);
    expect(c.lines.find((l: { label: string }) => l.label === "free").average).toBe(0);
    const ret = await run({
      mode: "retention",
      steps: ["start", "invited"],
      returns: ["return", "renew"],
      periods: 3,
      after: true,
    });
    expect(ret.rows.map((r: { counts: number[] }) => r.counts)).toEqual([
      [2, 1, 1, null],
      [1, null, null, null],
    ]);
    expect(ret.curve[1]).toMatchObject({ size: 2, n: 1, rate: 0.5 });
  } finally {
    ctx.cleanup();
  }
}, 30000);
