import { expect, test } from "bun:test";
import { call, project, testContext } from "./helpers";
test("request inputs are ephemeral, bots excluded by default, and a visit retains its first coarse context", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx);
    // A documentation network in the disposable test dictionary.
    await ctx.admin.insert("highkey.geo_networks", [
      { cidr: "192.0.2.5/32", country: "CA", region: "CA-ON", hosting: 0 },
    ]);
    await ctx.admin.command("SYSTEM RELOAD DICTIONARY highkey.geo_lookup");
    const now = new Date(Date.now() - 1000).toISOString().replace("T", " ").replace("Z", "");
    const base = {
      product_id: p.id,
      source_id: p.id,
      source: "web",
      event_time: now,
      received_at: now,
      expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace("T", " "),
      actor_id: "v",
      session_id: "s",
      identity_kind: "visitor",
      profile_id: "p",
      name: "page_view",
      request_site: "app.test",
      request_fetch: 1,
      request_web: 1,
    };
    const events = [
      {
        ...base,
        event_id: "one",
        request_ip: "192.0.2.5",
        request_ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/123.0.2.1 Safari/537.36",
        properties: { referrer: "app.test", utm_source: "newsletter", utm_medium: "email" },
      },
      { ...base, event_id: "bot", request_ip: "", request_ua: "Googlebot/2.1", properties: {} },
    ];
    await ctx.admin.command(
      `INSERT INTO highkey.events (${Object.keys(events[0]).join(",")}) FORMAT JSONEachRow\n${events.map((e) => JSON.stringify(e)).join("\n")}`,
    );
    const range = {
      from: new Date(Date.now() - 60000).toISOString(),
      to: new Date(Date.now() + 60000).toISOString(),
    };
    const query = (extra: object) =>
      call(ctx, "POST", `/api/products/${p.id}/query`, { ...range, ...extra });
    expect((await query({})).json.events).toMatchObject([
      {
        browser: "Chrome",
        country: "CA",
        region: "CA-ON",
        browser_version: "123.0.2.1",
        os_family: "Windows",
        device: "Desktop",
        referrer_name: "newsletter",
        referrer_type: "email",
        bot: "",
      },
    ]);
    expect((await query({ include_bots: true })).json.summary.total).toBe(2);
    expect((await query({ group_by: "property:context.browser" })).json.groups).toEqual([
      { count: 1, label: "Chrome", value: 1 },
    ]);
    const visit = await call(ctx, "POST", `/api/products/${p.id}/sessions/query`, range);
    expect(visit.json.rows).toMatchObject([
      { events: 1, os_family: "Windows", referrer_type: "email" },
    ]);
    const columns = (
      await ctx.admin.query<{ name: string; default_kind: string }>(
        "SELECT name,default_kind FROM system.columns WHERE database='highkey' AND table='events' AND startsWith(name,'request_')",
      )
    ).data;
    expect(columns.length).toBeGreaterThanOrEqual(5);
    expect(columns.every((c) => c.default_kind === "EPHEMERAL")).toBe(true);
  } finally {
    ctx.cleanup();
  }
}, 30000);
