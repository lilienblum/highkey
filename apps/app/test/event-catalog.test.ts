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
