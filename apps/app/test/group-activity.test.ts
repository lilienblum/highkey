import { expect, test } from "bun:test";
import { testContext, call, seedEvents, project } from "./helpers";
import { measureFunnel } from "../src/server/dashboards/funnel";
test("members can complete a group funnel together and new membership uses first retained activity", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      t = Date.now() - 60000,
      range = { from: new Date(t).toISOString(), to: new Date(t + 60000).toISOString() };
    const row = (id: string, at: number, person: string, team: string, name: string) => ({
      event_id: id,
      time: new Date(t + at),
      name,
      profile_id: person,
      actor_id: person,
      identity_kind: "visitor",
      groups: { team },
    });
    await seedEvents(p.id, [
      row("before", -1000, "p1", "acme", "start"),
      row("start", 1000, "p1", "acme", "start"),
      row("end", 2000, "p2", "acme", "finish"),
      row("other", 2000, "p3", "elsewhere", "finish"),
    ]);
    const get = async (extra: object) => {
      const r = await call(ctx, "POST", `/api/products/${p.id}/groups/activity`, {
        ...range,
        ...extra,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    expect((await get({})).rows[0]).toMatchObject({ id: "acme", members: 2, events: 2 });
    const group = await get({ type: "team", id: "acme" });
    expect(group.metrics.members).toBe(2);
    expect(group.newMembers.map((r: { members: number }) => r.members)).toEqual([1]);
    const filtered = await call(ctx, "POST", `/api/products/${p.id}/query`, {
      ...range,
      filters: [{ property: "group.team", op: "eq", value: "acme" }],
    });
    expect(filtered.json.summary.total).toBe(2);
    const counts = await measureFunnel(
      {
        signal: "funnel",
        by: "group",
        group_type: "team",
        steps: [{ event: "start" }, { event: "finish" }],
        window: "1h",
      },
      { from: new Date(t), to: new Date(t + 60000), bucket: "day" },
      { reader: ctx.readers.reader(p.id), source: null },
    );
    expect(counts.map((c) => c.value)).toEqual([1, 1]);
  } finally {
    ctx.cleanup();
  }
});
