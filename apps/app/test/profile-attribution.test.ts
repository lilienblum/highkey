import { afterAll, beforeAll, expect, test } from "bun:test";
import { call, project, testContext, type TestContext } from "./helpers";
let ctx: TestContext;
beforeAll(async () => {
  ctx = await testContext();
}, 300000);
afterAll(() => ctx?.cleanup());

test("a later identify links at most six preceding hours in the same source, actor and session without rewriting history", async () => {
  const p = await project(ctx, "Attribution"),
    other = await project(ctx, "Elsewhere");
  const src = (await call(ctx, "POST", `/api/products/${p.id}/sources`, { name: "Elsewhere" })).json
    .id;
  const now = Date.now() - 60000;
  const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const row = (id: string, offset: number, extra: object = {}) => ({
    product_id: p.id,
    source_id: p.id,
    event_id: id,
    name: "buy",
    source: "web",
    event_time: stamp(now + offset),
    received_at: stamp(now),
    identity_kind: "visitor",
    actor_id: "a",
    session_id: "visit",
    properties: { revenue: 1 },
    expires_at: stamp(now + 86400000).slice(0, 19),
    ...extra,
  });
  await ctx.admin.insert("highkey.events", [
    row("boundary", -21600000),
    row("too-old", -21600001),
    row("explicit", -1, { profile_id: "other" }),
    row("source", -1, { source_id: src }),
    row("actor", -1, { actor_id: "b" }),
    row("session", -1, { session_id: "next" }),
    row("future", 1),
  ]);
  const range = {
    from: new Date(now - 21601000).toISOString(),
    to: new Date(now).toISOString(),
    group_by: "profile",
  };
  const report = async () =>
    (await call(ctx, "POST", `/api/products/${p.id}/revenue/query`, range)).json;
  expect((await report()).rows).toContainEqual({ label: null, cents: "5", revenue_events: 5 });
  await ctx.admin.insert("highkey.events", [
    row("identify", 0, {
      record_type: "identify",
      profile_id: "buyer",
      traits: { name: "Sam", email: "sam@example.test" },
      properties: {},
    }),
    row("identify-other", -2, {
      product_id: other.id,
      source_id: other.id,
      record_type: "identify",
      profile_id: "foreign",
      properties: {},
    }),
  ]);
  expect((await report()).rows).toEqual([
    { label: null, cents: "4", revenue_events: 4 },
    { label: "buyer", cents: "1", revenue_events: 1 },
    { label: "other", cents: "1", revenue_events: 1 },
  ]);
  const future = await call(ctx, "POST", `/api/products/${p.id}/revenue/query`, {
    ...range,
    from: new Date(now).toISOString(),
    to: new Date(now + 2000).toISOString(),
  });
  expect(future.json.rows).toEqual([{ label: null, cents: "1", revenue_events: 1 }]);
  const original = await ctx.readers
    .reader(p.id)
    .query("SELECT profile_id FROM all_events WHERE event_id='boundary'");
  expect(original.data).toEqual([{ profile_id: null }]);
  const person = (path: string, q: object) =>
    call(ctx, "POST", `/api/products/${p.id}/people/${path}`, {
      from: range.from,
      to: new Date(now + 2000).toISOString(),
      ...q,
    });
  expect((await person("query", { search: "sam@example" })).json.rows).toMatchObject([
    { id: "buyer", events: 1 },
  ]);
  expect(
    (await person("query", { kind: "anonymous" })).json.rows
      .map((r: { id: string }) => r.id)
      .sort(),
  ).toEqual(["a", "b"]);
  const detail = await person("detail", { id: "buyer" });
  expect(detail.json).toMatchObject({
    events: 1,
    days_active: 1,
    revenue_cents: "1",
    traits: { name: "Sam" },
    top_events: [{ label: "buy", n: 1 }],
  });
  expect((await person("detail", { id: "foreign" })).status).toBe(404);
});
