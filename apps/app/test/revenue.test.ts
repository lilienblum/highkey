import { afterAll, beforeAll, expect, test } from "bun:test";
import { hashSecret } from "../src/server/db/keys";
import { one } from "../src/server/db/db";
import { reconcile } from "../src/server/registry";
import { call, project, testContext, type TestContext } from "./helpers";
import { joinAs } from "./auth-helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await testContext();
}, 300_000);
afterAll(() => ctx?.cleanup());

test("revenue opt-in is restricted to owners and admins over HTTP and MCP", async () => {
  const p = await project(ctx, "Restricted revenue");
  const path = `/api/products/${p.id}/revenue/settings`;
  for (const role of ["admin", "member", "viewer"] as const) {
    const headers = Object.fromEntries(
      await joinAs(await ctx.auth(), ctx.session, `${role}@revenue.test`, role),
    );
    expect((await call(ctx, "GET", path, undefined, headers)).json).toEqual({
      allow_browser_revenue: false,
    });
    expect((await call(ctx, "PATCH", path, { allow_browser_revenue: true }, headers)).status).toBe(
      role === "admin" ? 200 : 403,
    );
    const key = await call(
      ctx,
      "POST",
      "/api/keys",
      { name: "Revenue", access: role === "viewer" ? "read" : "write" },
      headers,
    );
    expect(key.status).toBe(200);
    const result = await call(
      ctx,
      "POST",
      "/api/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "update_revenue_settings",
          arguments: { project: p.id, allow_browser_revenue: false },
        },
      },
      {
        cookie: "",
        origin: "",
        authorization: `Bearer ${key.json.key}`,
        accept: "application/json, text/event-stream",
      },
    );
    expect(result.status).toBe(200);
    if (role === "viewer") expect(result.json.error.code).toBe(-32602);
    else expect(result.json.result.isError).toBe(role !== "admin");
    expect((await call(ctx, "GET", path)).json).toEqual({ allow_browser_revenue: false });
  }
  for (const input of [{}, { allow_browser_revenue: 1 }, { allow_browser_revenue: "true" }]) {
    expect((await call(ctx, "PATCH", path, input)).status).toBe(422);
  }
});

test("server keys are secret, source scoped, and mirrored with browser revenue off by default", async () => {
  const p = await project(ctx, "Revenue keys");
  const source = await call(ctx, "POST", `/api/products/${p.id}/sources`, { name: "Checkout" });
  const path = `/api/products/${p.id}`;
  expect((await call(ctx, "GET", `${path}/revenue/settings`)).json).toEqual({
    allow_browser_revenue: false,
  });
  for (const input of [
    { kind: "unknown" },
    { kind: "server", allowed_origins: ["https://shop.example"] },
  ])
    expect((await call(ctx, "POST", `${path}/keys`, { label: "Invalid", ...input })).status).toBe(
      400,
    );
  const created = await call(ctx, "POST", `${path}/keys`, {
    label: "Payments",
    source_id: source.json.id,
    kind: "server",
  });
  expect(created.status).toBe(200);
  expect(created.json.key).toStartWith("sk_");
  expect(created.json.source_id).toBe(source.json.id);
  const row = await one<{ hash: string; kind: string }>(
    ctx.db,
    "SELECT hash, kind FROM ingestion_keys WHERE id = ?",
    [created.json.id],
  );
  expect(row).toEqual({ hash: hashSecret(created.json.key), kind: "server" });
  const listed = await call(ctx, "GET", `${path}/keys`);
  expect(listed.json[0].kind).toBe("server");
  expect(JSON.stringify(listed.json)).not.toContain(created.json.key);
  expect(
    (
      await call(ctx, "PATCH", `${path}/keys/${created.json.id}`, {
        allowed_origins: ["https://shop.example"],
      })
    ).status,
  ).toBe(400);
  const policy = async () =>
    (
      await ctx.admin.query(
        "SELECT server_key, allow_browser_revenue FROM highkey.ingest_key_policies WHERE hash = {hash:String}",
        { params: { hash: row!.hash } },
      )
    ).data[0];
  expect(await policy()).toEqual({ server_key: 1, allow_browser_revenue: 0 });
  expect(
    (await call(ctx, "PATCH", `${path}/revenue/settings`, { allow_browser_revenue: true })).status,
  ).toBe(200);
  expect(await policy()).toEqual({ server_key: 1, allow_browser_revenue: 1 });
  await call(ctx, "PATCH", `${path}/revenue/settings`, { allow_browser_revenue: false });
  await reconcile(ctx);
  expect(await policy()).toEqual({ server_key: 1, allow_browser_revenue: 0 });
  const other = await testContext();
  try {
    expect(
      (await call(other, "PATCH", `${path}/revenue/settings`, { allow_browser_revenue: true }))
        .status,
    ).toBe(404);
  } finally {
    other.cleanup();
  }
});
