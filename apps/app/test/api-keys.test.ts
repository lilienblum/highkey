import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KEY_RATE_LIMIT } from "../src/server/auth/auth";
import { authRequest, joinAs, signUp, testAuth } from "./auth-helpers";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext();
}, 300_000);
afterEach(() => ctx?.cleanup());

/** A script's request: the key and nothing a browser would add. */
const keyed = (key: string) => ({ authorization: `Bearer ${key}`, cookie: "", origin: "" });
const as = (who: Headers) => ({ cookie: who.get("cookie") as string });

async function newKey(
  access: "read" | "write",
  who: Headers = ctx.session,
  name = `${access} key`,
): Promise<{ id: string; key: string }> {
  const reply = await call(ctx, "POST", "/api/keys", { name, access }, as(who));
  expect(reply.status).toBe(200);
  return reply.json;
}

describe("API keys", () => {
  test("a_read_key_reads_and_cannot_write", async () => {
    const shop = await project(ctx, "Shop");
    const { key } = await newKey("read");
    expect(key).toStartWith("hk_");
    const sources = `/api/products/${shop.id}/sources`;
    expect((await call(ctx, "GET", sources, undefined, keyed(key))).status).toBe(200);
    // The key header works as well as a bearer token.
    expect(
      (await call(ctx, "GET", sources, undefined, { "x-api-key": key, cookie: "" })).status,
    ).toBe(200);
    const write = await call(ctx, "POST", sources, { name: "App" }, keyed(key));
    expect(write.status).toBe(403);
    expect(write.json.code).toBe("forbidden");
    // A key cannot mint or revoke keys.
    const minted = await call(ctx, "POST", "/api/keys", { name: "x", access: "read" }, keyed(key));
    expect(minted.status).toBe(403);
    expect((await call(ctx, "GET", sources, undefined, keyed("hk_not_a_key"))).status).toBe(401);
  });

  test("a_write_key_is_capped_by_a_viewer_role", async () => {
    const auth = await ctx.auth();
    const shop = await project(ctx, "Shop");
    const member = await joinAs(auth, ctx.session, "member@example.com", "member");
    const { key } = await newKey("write", member);
    const sources = `/api/products/${shop.id}/sources`;
    expect((await call(ctx, "POST", sources, { name: "App" }, keyed(key))).status).toBe(200);
    const members = (await auth.api.listMembers({ headers: ctx.session })) as {
      members: { id: string; user: { email: string } }[];
    };
    const row = members.members.find((m) => m.user.email === "member@example.com");
    await auth.api.updateMemberRole({
      body: { memberId: row?.id as string, role: "viewer" },
      headers: ctx.session,
    });
    expect((await call(ctx, "POST", sources, { name: "Web" }, keyed(key))).status).toBe(403);
    expect((await call(ctx, "GET", sources, undefined, keyed(key))).status).toBe(200);
    // A viewer makes read-only keys only.
    const refused = await call(
      ctx,
      "POST",
      "/api/keys",
      { name: "w", access: "write" },
      as(member),
    );
    expect(refused.status).toBe(403);
    expect((await newKey("read", member)).key).toStartWith("hk_");
  });

  test("a_removed_members_keys_stop_at_once", async () => {
    const auth = await ctx.auth();
    const member = await joinAs(auth, ctx.session, "leaving@example.com", "member");
    const { key } = await newKey("read", member);
    expect((await call(ctx, "GET", "/api/products", undefined, keyed(key))).status).toBe(200);
    await auth.api.removeMember({
      body: { memberIdOrEmail: "leaving@example.com" },
      headers: ctx.session,
    });
    const refused = await call(ctx, "GET", "/api/products", undefined, keyed(key));
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("not_a_member");
  });

  test("owners_see_and_revoke_everyones_keys_but_never_their_secrets", async () => {
    const auth = await ctx.auth();
    const member = await joinAs(auth, ctx.session, "member@example.com", "member");
    const mine = await newKey("write", ctx.session, "Owner key");
    const theirs = await newKey("read", member, "Member key");
    const listed = (who: Headers) => call(ctx, "GET", "/api/keys", undefined, as(who));
    const memberView = await listed(member);
    expect(memberView.json.map((k: { name: string }) => k.name)).toEqual(["Member key"]);
    const ownerView = await listed(ctx.session);
    expect(ownerView.json.map((k: { name: string }) => k.name).sort()).toEqual([
      "Member key",
      "Owner key",
    ]);
    expect(ownerView.json.find((k: { name: string }) => k.name === "Member key")).toMatchObject({
      id: theirs.id,
      access: "read",
      user: { email: "member@example.com" },
    });
    const text = new TextDecoder().decode(ownerView.bytes);
    expect(text).not.toContain(mine.key);
    expect(text).not.toContain(theirs.key);
    expect(Object.keys(ownerView.json[0])).not.toContain("key");
    // The plugin's own endpoints are closed: keys are made and listed only through /api/keys.
    const direct = await authRequest(auth, "/api-key/create", { name: "x" }, as(member));
    expect(direct.status).toBe(404);
    // A member cannot revoke someone else's key, nor can another organization.
    expect((await call(ctx, "DELETE", `/api/keys/${mine.id}`, undefined, as(member))).status).toBe(
      404,
    );
    const stranger = await signUp(auth, "stranger@example.com");
    expect(
      (await call(ctx, "DELETE", `/api/keys/${mine.id}`, undefined, as(stranger))).status,
    ).toBe(404);
    expect((await call(ctx, "DELETE", `/api/keys/${theirs.id}`)).status).toBe(204);
    expect((await call(ctx, "GET", "/api/products", undefined, keyed(theirs.key))).status).toBe(
      401,
    );
    expect((await listed(member)).json).toEqual([]);
  });

  test("the_read_api_requires_a_key_and_answers_cors_with_authorization", async () => {
    await project(ctx, "Shop");
    const page = "http://localhost:5173";
    const path = "/api/read/products/shop/dashboards";
    const preflight = await call(ctx, "OPTIONS", path, undefined, {
      origin: page,
      cookie: "",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    });
    expect(preflight.headers.get("access-control-allow-headers")?.split(",")).toContain(
      "authorization",
    );
    const bare = await call(ctx, "GET", path, undefined, { origin: page, cookie: "" });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("access-control-allow-origin")).toBe(page);
    const { key } = await newKey("read");
    const read = await call(ctx, "GET", path, undefined, { ...keyed(key), origin: page });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe(page);
  });

  test("keys_are_rate_limited_per_minute", async () => {
    expect(KEY_RATE_LIMIT).toEqual({ timeWindow: 60_000, maxRequests: 1_000 });
    const limited = testAuth(ctx, { keyRateLimit: { timeWindow: 60_000, maxRequests: 3 } });
    ctx.auth = async () => limited;
    const { key } = await newKey("read");
    for (let n = 0; n < 3; n++)
      expect((await call(ctx, "GET", "/api/products", undefined, keyed(key))).status).toBe(200);
    const over = await call(ctx, "GET", "/api/products", undefined, keyed(key));
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("rate_limited");
  });
});
