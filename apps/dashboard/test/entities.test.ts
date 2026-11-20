import { afterEach, beforeEach, expect, test } from "bun:test";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext();
}, 300_000);
afterEach(() => ctx?.cleanup());
const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

test("profile and group mutations preserve scalar types, event order, first-copy dedup and project isolation", async () => {
  const a = await project(ctx, "A");
  const b = await project(ctx, "B");
  const now = Date.now();
  const row = (record_type: string, event_id: string, age: number, extra: object = {}) => ({
    product_id: a.id,
    source_id: a.id,
    event_id,
    name: "mutation",
    source: "server",
    event_time: stamp(now - age),
    received_at: stamp(now),
    expires_at: stamp(now + 86400000).slice(0, 19),
    record_type,
    ...extra,
  });
  const identify = (id: string, age: number, extra: object) =>
    row("identify", id, age, { profile_id: "user-1", ...extra });
  await ctx.admin.insert(
    "highkey.events",
    [
      identify("a", 3000, { traits: { name: "Sam", active: true, count: 10, "plan.name": "Pro" } }),
      identify("c", 1000, { traits: { name: "New name", count: 20 }, increments: { count: -2 } }),
      identify("b", 2000, { increments: { count: 5 } }),
      row("group", "g1", 3000, {
        group_type: "team",
        group_id: "t1",
        group_name: "Team",
        traits: { seats: 2 },
      }),
      row("group", "g2", 2000, {
        group_type: "team",
        group_id: "t1",
        group_name: "Renamed",
        increments: { seats: 3 },
      }),
      row("identify", "other", 2000, {
        product_id: b.id,
        source_id: b.id,
        profile_id: "private",
        traits: { email: "private@example.test" },
      }),
    ],
    { settings: { json_type_escape_dots_in_keys: 1 } },
  );
  await ctx.admin.insert("highkey.events", [
    identify("c", 1000, { received_at: stamp(now + 100), increments: { count: 999 } }),
  ]);
  const read = (kind: string, body: object = {}) =>
    call(ctx, "POST", `/api/products/${a.slug}/${kind}/query`, body);
  const profiles = await read("profiles");
  expect(profiles.status).toBe(200);
  expect(profiles.json.total).toBe(1);
  expect(profiles.json.rows[0].traits).toEqual({
    name: "New name",
    active: true,
    count: 18,
    "plan.name": "Pro",
  });
  const groups = await read("groups", { type: "team", search: "Renamed" });
  expect(groups.status).toBe(200);
  expect(groups.json.rows[0]).toMatchObject({
    id: "t1",
    type: "team",
    name: "Renamed",
    traits: { seats: 5 },
  });
  expect((await read("groups", { type: "company" })).json.rows).toEqual([]);
  expect((await read("profiles", { id: "private" })).json.rows).toEqual([]);
  expect(
    (await ctx.readers.reader(a.id).query<{ n: number }>("SELECT count() AS n FROM all_events"))
      .data[0]?.n,
  ).toBe(0);
  expect((await read("profiles", { page_size: 101 })).status).toBe(400);
  expect((await read("profiles", { search: "' OR 1=1 --" })).json.rows).toEqual([]);
});
