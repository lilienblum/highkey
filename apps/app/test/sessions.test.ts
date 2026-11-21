import { afterAll, beforeAll, expect, test } from "bun:test";
import { call, project, seedLogs, testContext, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await testContext();
}, 300000);
afterAll(() => ctx?.cleanup());

test("only live events establish session boundaries; session keys isolate actors, sources, and projects", async () => {
  const shop = await project(ctx),
    other = await project(ctx);
  const second = (await call(ctx, "POST", `/api/products/${shop.id}/sources`, { name: "Mobile" }))
    .json.id;
  const start = Date.now() - 60000;
  const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const event = (event_id: string, offset: number, props: object, extra: object = {}) => ({
    event_id,
    product_id: shop.id,
    source_id: shop.id,
    name: "page_view",
    source: "web",
    actor_id: "a",
    session_id: "s",
    identity_kind: "visitor",
    event_time: stamp(start + offset),
    received_at: stamp(start + 10000),
    expires_at: stamp(start + 86400000).slice(0, 19),
    properties: props,
    ...extra,
  });
  await ctx.admin.insert("highkey.events", [
    event("back-before", -10000, { path: "/old", referrer: "ignored" }, { backfill: true }),
    event("entry", 0, { path: "/home", referrer: "example.org", utm_medium: "email" }),
    event("middle", 2000, { path: "/docs", request_id: "request" }),
    event("end", 3000, { path: "/pay", revenue: -50, trace_id: "trace" }, { profile_id: "buyer" }),
    event("ai", 1000, { model: "m" }, { name: "ai_generation" }),
    event("back-after", 20000, { revenue: 250 }, { name: "purchase", backfill: true }),
    event("back-only", 1000, {}, { backfill: true, session_id: "never-started" }),
    event("another", 1000, { path: "/mobile" }, { source_id: second }),
    event("different-visitor", 1000, { path: "/different" }, { actor_id: "b" }),
    event("foreign", 1000, { path: "/foreign" }, { product_id: other.id, source_id: other.id }),
    event(
      "inert",
      1000,
      { path: "/private" },
      { session_id: null, actor_id: null, identity_kind: null },
    ),
  ]);
  const range = {
    from: new Date(start - 1).toISOString(),
    to: new Date(start + 2500).toISOString(),
  };
  const read = (path: string, q: object) =>
    call(ctx, "POST", `/api/products/${shop.slug}/sessions/${path}`, { ...range, ...q });
  const list = await read("query", {});
  expect(list.json.rows?.length ?? list.json).toEqual(3);
  const filtered = await read("query", {
    search: "/docs",
    min_page_views: 3,
    min_duration_ms: 2999,
    bounced: false,
  });
  expect(filtered.json.rows).toHaveLength(1);
  expect(filtered.json.rows[0]).toMatchObject({
    actor_id: "a",
    session_id: "s",
    source_id: shop.id,
    start,
    end: start + 3000,
    entry_page: "/home",
    exit_page: "/pay",
    events: 6,
    page_views: 4,
    duration_ms: 3000,
    referrer: "example.org",
    campaign: { utm_medium: "email" },
    profile_id: "buyer",
    revenue_cents: "200",
    bounced: false,
  });
  expect((await read("query", { page_size: 2 })).json.has_more).toBe(true);
  expect(
    (await read("query", { from: new Date(start + 1).toISOString(), search: "/docs" })).json.rows,
  ).toEqual([]);
  expect((await read("query", { source_id: other.id })).status).toBe(404);
  await seedLogs(shop.id, [
    { log_id: "related", time: new Date(start + 1500), trace_id: "trace" },
    {
      log_id: "by-request",
      time: new Date(start + 1501),
      request_id: "request",
      source_id: second,
    },
    { log_id: "wrong", time: new Date(start + 1500), trace_id: "unknown" },
    { log_id: "too-late", time: new Date(start + 3001), trace_id: "trace" },
  ]);
  await seedLogs(other.id, [
    { log_id: "foreign", time: new Date(start + 1500), trace_id: "trace" },
  ]);
  const detail = await read("detail", {
    actor_id: "a",
    session_id: "s",
    source_id: shop.id,
    page_size: 3,
  });
  expect(detail.json.events?.map((v: { name: string }) => v.name) ?? detail.json).toEqual([
    "page_view",
    "page_view",
    "ai_generation",
  ]);
  expect(detail.json.has_more).toBe(true);
  expect(detail.json.logs.map((v: { log_id: string }) => v.log_id)).toEqual([
    "related",
    "by-request",
  ]);
  expect(detail.json.pages).toHaveLength(4);
  expect(detail.json.mix[0]).toEqual({ label: "page_view", n: 4 });
  expect((await read("detail", { actor_id: "b", session_id: "s", source_id: second })).status).toBe(
    404,
  );
}, 30000);
