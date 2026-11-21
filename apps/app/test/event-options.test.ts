import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
test("event facets retain types, exclude other sources and bound high-cardinality values; regex and empty operators work with saved views", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      t = Date.now(),
      range = { from: new Date(t - 60000).toISOString(), to: new Date(t + 60000).toISOString() };
    await seedEvents(p.id, [
      ...["1", 1, false, "", null, "pro"].map((v, i) => ({
        event_id: `e${i}`,
        name: "test",
        properties: v === null ? {} : { "org.plan": v },
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        event_id: `id${i}`,
        name: "other",
        properties: { k: `x${i}` },
      })),
    ]);
    const get = async (path: string, extra: object) =>
      (await call(ctx, "POST", `/api/products/${p.id}/${path}`, { ...range, ...extra })).json;
    expect(await get("event-options", { event: "test", property: "org.plan" })).toEqual({
      names: ["other", "test"],
      keys: ["org.plan"],
      values: ['""', '"1"', '"pro"', "1", "false"],
    });
    expect((await get("event-options", { property: "k" })).values.length).toBe(32);
    for (const [op, value, count] of [
      ["regex", "^pr", 1],
      ["empty", undefined, 2],
      ["not_empty", undefined, 4],
    ]) {
      const filter = { property: "org.plan", op, ...(value === undefined ? {} : { value }) };
      expect((await get("query", { event: "test", filters: [filter] })).summary.total).toBe(count);
      expect(
        (
          await call(ctx, "POST", `/api/products/${p.id}/views`, {
            document: { version: 1, name: String(op), query: { event: "test", filters: [filter] } },
          })
        ).status,
      ).toBe(200);
    }
  } finally {
    ctx.cleanup();
  }
}, 30000);
