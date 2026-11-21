import { expect, test } from "bun:test";
import { call, project, seedEvents, testContext } from "./helpers";
import { eventSentence } from "../src/lib/event-catalog";

test("catalog edits classify conversions without changing stored events, and templates keep scalar types", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      other = await project(ctx);
    const path = `/api/products/${p.id}/event-catalog`;
    const save = (q: object) => call(ctx, "PUT", path, q);
    const def = {
      name: "shipped",
      color: "aqua",
      icon: "package",
      description: "A completed shipment",
      sentence: "Order {order_id}: {paid} ({refund})",
      conversion: true,
    };
    expect((await save(def)).json).toEqual(def);
    expect((await save({ ...def, color: "var(--something)" })).status).toBe(400);
    expect((await call(ctx, "GET", `/api/products/${other.id}/event-catalog`)).json).toEqual([]);
    expect(eventSentence(def.sentence, { order_id: 7, paid: false, refund: 0 })).toBe(
      "Order 7: false (0)",
    );
    await seedEvents(p.id, [
      { event_id: "a", name: "shipped", profile_id: "buyer" },
      { event_id: "b", name: "other", profile_id: "buyer" },
    ]);
    const range = {
      from: new Date(Date.now() - 60000).toISOString(),
      to: new Date(Date.now() + 60000).toISOString(),
    };
    const conversions = await call(ctx, "POST", `/api/products/${p.id}/query`, {
      ...range,
      names: ["shipped"],
    });
    expect(conversions.json.summary.total).toBe(1);
    const person = () =>
      call(ctx, "POST", `/api/products/${p.id}/people/detail`, { ...range, id: "buyer" });
    expect((await person()).json.conversions).toBe(1);
    await call(ctx, "DELETE", path, { name: def.name });
    expect((await person()).json).toMatchObject({ events: 2, conversions: 0 });
  } finally {
    ctx.cleanup();
  }
}, 30000);

test("custom event alternatives match typed properties once per raw event and work as funnel steps", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      other = await project(ctx);
    const endpoint = `/api/products/${p.id}`;
    const rules = [
      { event: "page_view", filters: [{ property: "path", op: "starts_with", value: "/docs" }] },
      { event: "page_view", filters: [{ property: "version", op: "eq", value: 1 }] },
      { event: "signup" },
    ];
    const save = (name: string, rules: unknown) =>
      call(ctx, "PUT", `${endpoint}/event-catalog`, { name, rules, conversion: true });
    expect((await save("@activation", rules)).status).toBe(200);
    expect((await save("@recursive", [{ event: "@activation" }])).status).toBe(400);
    const now = Date.now() - 10000;
    await seedEvents(
      p.id,
      [
        { name: "page_view", properties: { path: "/docs/a", version: 1 } },
        { name: "page_view", properties: { path: "/about", version: "1" } },
        { name: "signup", properties: {} },
        { name: "purchase", properties: { revenue: 99 } },
      ].map((r, i) => ({
        ...r,
        event_id: `custom-${i}`,
        time: new Date(now + i),
        identity_kind: "visitor",
        actor_id: "v",
        profile_id: "buyer",
      })),
    );
    const range = {
      from: new Date(now - 60000).toISOString(),
      to: new Date(now + 60000).toISOString(),
    };
    const qry = (id: string) =>
      call(ctx, "POST", `/api/products/${id}/query`, { ...range, event: "@activation" });
    const queried = await qry(p.id);
    expect(queried.json.summary?.total).toBe(2);
    expect(queried.json.event_names).toContain("@activation");
    expect((await qry(other.id)).status).toBe(400);
    const widget = {
      id: "f",
      title: "Conversion funnel",
      view: { type: "table" },
      queries: {
        steps: { signal: "funnel", steps: [{ event: "@activation" }, { event: "purchase" }] },
      },
    };
    const result = await call(ctx, "POST", `/api/read/products/${p.id}/widgets/run`, {
      ...range,
      widget,
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json.rows).toEqual([
      ["@activation", 1, 1, 1],
      ["purchase", 1, 1, 1],
    ]);
    expect(
      (await call(ctx, "POST", `${endpoint}/people/detail`, { ...range, id: "buyer" })).json
        .conversions,
    ).toBe(2);
  } finally {
    ctx.cleanup();
  }
}, 30000);
