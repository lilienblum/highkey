import { test, expect } from "bun:test";
import { call, testContext, project, seedEvents } from "./helpers";
import { notifyTick } from "../src/server/notifications";
test("custom event notices render structured payloads, hide secrets, checkpoint retries and fire a closed session funnel once", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      root = `/api/products/${p.id}/notifications`,
      start = Date.now() - 3600000;
    ctx.now = () => new Date(start);
    const dest = await call(ctx, "POST", root + "/destinations", {
      name: "Test",
      kind: "webhook",
      url: "https://example.com/secret-hook",
      headers: { authorization: "private" },
      body: { text: "{{message}}" },
    });
    expect(dest.status, JSON.stringify(dest.json)).toBe(200);
    expect(JSON.stringify((await call(ctx, "GET", root + "/config")).json)).not.toContain(
      "secret-hook",
    );
    expect(
      (await ctx.db.execute("SELECT sealed FROM notification_destinations")).rows[0].sealed,
    ).not.toContain("private");
    await call(ctx, "PUT", `/api/products/${p.id}/event-catalog`, {
      name: "@activation",
      rules: [{ event: "finish", filters: [{ property: "plan", op: "eq", value: "pro" }] }],
    });
    const rule = await call(ctx, "POST", root + "/rules", {
      kind: "event",
      name: "Activation",
      steps: ["@activation"],
      template: "{{name}}: {{properties.plan}}",
      destination: dest.json.id,
    });
    expect(rule.status).toBe(200);
    expect(
      (
        await call(ctx, "POST", root + "/rules", {
          kind: "funnel",
          name: "Visit",
          steps: ["start", "@activation"],
        })
      ).status,
    ).toBe(200);
    await seedEvents(
      p.id,
      ["start", "finish", "unrelated"].map((name, i) => ({
        event_id: `e${i}`,
        name,
        time: new Date(start + 1000 + Math.max(0, i - 1)),
        identity_kind: "visitor",
        actor_id: "v",
        session_id: "s",
        profile_id: "p",
        properties: { plan: "pro" },
      })),
    );
    let clock = Date.now() + 20000;
    ctx.now = () => new Date(clock);
    const sent: unknown[] = [];
    const send: Parameters<typeof notifyTick>[1] = async (
      _ctx,
      _p,
      _kind,
      config,
      _id,
      _message,
      payload,
    ) => {
      sent.push(payload);
      expect(config.headers.authorization).toBe("private");
      if (sent.length === 1) throw Error("transient");
    };
    await notifyTick(ctx, send);
    const first = await call(ctx, "GET", root + "/history");
    expect(first.json.map((r: { status: string }) => r.status).sort()).toEqual([
      "dashboard",
      "pending",
    ]);
    clock += 31000;
    await notifyTick(ctx, send);
    await notifyTick(ctx, send);
    expect(sent).toEqual([{ text: "finish: pro" }, { text: "finish: pro" }]);
    const history = (await call(ctx, "GET", root + "/history")).json;
    expect(history.length).toBe(2);
    expect(history.find((r: { rule_name: string }) => r.rule_name === "Visit")).toMatchObject({
      event_id: "e1",
      message: "finish",
    });
    expect(history.find((r: { rule_name: string }) => r.rule_name === "Activation")).toMatchObject({
      status: "sent",
      event_id: "e1",
      profile_id: "p",
    });
  } finally {
    ctx.cleanup();
  }
}, 30000);
