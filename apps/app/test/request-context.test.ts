import { expect, test } from "bun:test";
import { call, project, testContext } from "./helpers";
test("request inputs are ephemeral, bots excluded by default, and a visit retains its first coarse context", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx);
    // A documentation network in the disposable test dictionary.
    await ctx.admin.insert("highkey.geo_networks", [
      { cidr: "192.0.2.5/32", country: "CA", region: "CA-ON", hosting: 0 },
      { cidr: "2001:db8:12::/48", country: "DE", region: "DE-BE", hosting: 1 },
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
    expect(
      (
        await ctx.admin.query(
          "SELECT highkey_browser('Mozilla Chrome/123.0 SamsungBrowser/24.1') AS b,highkey_browser_version('SamsungBrowser/24.1','Samsung Internet') AS v,highkey_os('Linux Ubuntu/24.04') AS os,highkey_os_version('Linux Ubuntu/24.04','Ubuntu') AS ov",
        )
      ).data,
    ).toEqual([{ b: "Samsung Internet", v: "24.1", os: "Ubuntu", ov: "24.04" }]);
    const additions = [
      {
        event_id: "hosting",
        request_ip: "2001:db8:12::c",
        request_ua: "Mozilla/5.0",
        request_fetch: 1,
        properties: { referrer: "search.test", ref: "claude.ai" },
      },
      {
        event_id: "no-fetch",
        request_ip: "",
        request_ua: "Mozilla/5.0 Firefox/123",
        request_fetch: 0,
        properties: { referrer: "APP.TEST" },
      },
      {
        event_id: "paid",
        request_ip: "",
        request_ua: "Mozilla/5.0",
        request_fetch: 1,
        properties: { referrer: "google.com", ref: "other", utm_source: "ad", utm_medium: "cpc" },
      },
    ].map((r) => ({ ...base, ...r }));
    await ctx.admin.command(
      `INSERT INTO highkey.events (${Object.keys(additions[0]).join(",")}) FORMAT JSONEachRow\n${additions.map((r) => JSON.stringify(r)).join("\n")}`,
    );
    const records = (await query({ include_bots: true })).json.events;
    for (const row of [
      {
        event_id: "hosting",
        country: "DE",
        region: "DE-BE",
        bot: "suspected",
        referrer_name: "claude.ai",
        referrer_type: "ai",
      },
      { event_id: "no-fetch", bot: "suspected", referrer_name: "", referrer_type: "direct" },
      { event_id: "paid", bot: "", referrer_name: "ad", referrer_type: "paid" },
    ])
      expect(records).toContainEqual(expect.objectContaining(row));
    expect(JSON.stringify(records)).not.toMatch(/2001:db8|Mozilla\/|192\.0\.2\.5/);
  } finally {
    ctx.cleanup();
  }
}, 30000);
