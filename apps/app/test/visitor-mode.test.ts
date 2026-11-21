import { test, expect } from "bun:test";
import { call, project, testContext } from "./helpers";
test("new sources count no visitors by default; day, project and source salt a cookieless visit independently", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx);
    expect((await call(ctx, "GET", `/api/products/${p.id}/sources`)).json[0].visitor_mode).toBe(
      "off",
    );
    const s = (
      await call(ctx, "POST", `/api/products/${p.id}/sources`, {
        name: "Browser",
        visitor_mode: "cookieless",
      })
    ).json;
    const k = (
      await call(ctx, "POST", `/api/products/${p.id}/keys`, { source_id: s.id, label: "Site" })
    ).json;
    expect(
      (
        await ctx.admin.query<{ mode: string }>(
          "SELECT mode FROM highkey.visitor_policies WHERE hash=hex(SHA256({key:String})) OR hash=lower(hex(SHA256({key:String})))",
          { params: { key: k.key } },
        )
      ).data,
    ).toEqual([{ mode: "cookieless" }]);
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const rows = [
      ["a", "salt1", s.id],
      ["b", "salt1", s.id],
      ["c", "salt2", s.id],
      ["d", "salt1", p.id],
      ["e", "", s.id],
    ].map(([id, salt, source]) => ({
      product_id: p.id,
      source_id: source,
      event_id: id,
      name: "page_view",
      source: "browser",
      event_time: now,
      received_at: now,
      expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace("T", " "),
      day_salt: salt,
      visit_nonce: "only-in-ram",
      request_ip: "192.0.2.5",
      request_ua: "browser",
      properties: {},
    }));
    await ctx.admin.command(
      `INSERT INTO highkey.events (${Object.keys(rows[0]).join(",")}) FORMAT JSONEachRow\n${rows.map((r) => JSON.stringify(r)).join("\n")}`,
    );
    const found = await ctx.readers
      .reader(p.id)
      .query<{ actor_id: string | null; session_id: string | null }>(
        "SELECT actor_id,session_id FROM all_events ORDER BY event_id",
      );
    expect(found.data[0].actor_id).toMatch(/^[0-9a-f]{64}$/);
    expect(found.data[0]).toEqual(found.data[1]);
    expect(found.data[0].actor_id).not.toBe(found.data[2].actor_id);
    expect(found.data[0].session_id).not.toBe(found.data[2].session_id);
    expect(found.data[0].actor_id).not.toBe(found.data[3].actor_id);
    expect(found.data[4]).toEqual({ actor_id: null, session_id: null });
  } finally {
    ctx.cleanup();
  }
}, 30000);
