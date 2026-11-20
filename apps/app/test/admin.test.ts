// The server admin (the first account on a self-host; Dan on the hosted service): find people and
// organizations, ban and unban, end someone's sessions, and hand over a one-time reset link.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authRequest, signUp } from "./auth-helpers";
import { call, type TestContext, testContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext();
}, 300_000);
afterEach(() => ctx?.cleanup());

const as = (who: Headers) => ({ cookie: who.get("cookie") as string });

async function userId(email: string): Promise<string> {
  const reply = await call(ctx, "GET", `/api/admin/users?search=${encodeURIComponent(email)}`);
  return (reply.json as { id: string; email: string }[]).find((u) => u.email === email)
    ?.id as string;
}

describe("server admin", () => {
  test("the_first_account_is_the_server_admin", async () => {
    await signUp(await ctx.auth(), "second@example.com", "Second");
    const users = await call(ctx, "GET", "/api/admin/users");
    expect(users.status).toBe(200);
    expect(users.json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "owner@highkey.test", role: "admin", banned: false }),
        expect.objectContaining({ email: "second@example.com", role: "user", banned: false }),
      ]),
    );
    const found = await call(ctx, "GET", "/api/admin/users?search=SECOND");
    expect(found.json.map((u: { email: string }) => u.email)).toEqual(["second@example.com"]);
    const orgs = await call(ctx, "GET", "/api/admin/organizations?search=second");
    expect(orgs.json).toEqual([
      expect.objectContaining({ name: "Second", members: 1, projects: 0 }),
    ]);
  });

  test("only_the_server_admin_reaches_admin_routes", async () => {
    const other = await signUp(await ctx.auth(), "other@example.com");
    for (const [method, path] of [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/organizations"],
      ["POST", `/api/admin/users/${await userId("other@example.com")}/ban`],
    ] as const) {
      const refused = await call(ctx, method, path, {}, as(other));
      expect({ path, status: refused.status }).toEqual({ path, status: 403 });
    }
    // An API key never acts as the server admin, even the admin's own.
    const key = (await call(ctx, "POST", "/api/keys", { name: "k", access: "write" })).json.key;
    const keyed = await call(ctx, "GET", "/api/admin/users", undefined, {
      cookie: "",
      authorization: `Bearer ${key}`,
    });
    expect(keyed.status).toBe(403);
  });

  test("a_banned_user_cannot_sign_in", async () => {
    const auth = await ctx.auth();
    const person = await signUp(auth, "spam@example.com");
    const key = (await call(ctx, "POST", "/api/keys", { name: "k", access: "read" }, as(person)))
      .json.key;
    const id = await userId("spam@example.com");
    expect((await call(ctx, "POST", `/api/admin/users/${id}/ban`, { reason: "spam" })).status).toBe(
      200,
    );
    const signIn = () =>
      authRequest(auth, "/sign-in/email", {
        email: "spam@example.com",
        password: "a password long enough",
      });
    expect((await signIn()).status).toBe(403);
    expect(await auth.api.getSession({ headers: person })).toBeNull();
    const keyed = await call(ctx, "GET", "/api/products", undefined, {
      cookie: "",
      authorization: `Bearer ${key}`,
    });
    expect(keyed.status).toBe(403);
    expect(keyed.json.code).toBe("banned");
    // The admin cannot ban themselves.
    const self = await call(
      ctx,
      "POST",
      `/api/admin/users/${await userId("owner@highkey.test")}/ban`,
      {},
    );
    expect(self.status).toBe(400);
    expect((await call(ctx, "POST", `/api/admin/users/${id}/unban`, {})).status).toBe(200);
    expect((await signIn()).status).toBe(200);
  });

  test("revoking_sessions_signs_someone_out_everywhere", async () => {
    const auth = await ctx.auth();
    const person = await signUp(auth, "lost@example.com");
    const id = await userId("lost@example.com");
    expect((await call(ctx, "POST", `/api/admin/users/${id}/revoke-sessions`, {})).status).toBe(
      200,
    );
    expect(await auth.api.getSession({ headers: person })).toBeNull();
  });

  test("a_reset_link_signs_in_once", async () => {
    const auth = await ctx.auth();
    await signUp(auth, "forgetful@example.com");
    const id = await userId("forgetful@example.com");
    const reply = await call(ctx, "POST", `/api/admin/users/${id}/reset-link`, {});
    expect(reply.status).toBe(200);
    const link = new URL(reply.json.link as string);
    expect(link.origin + link.pathname).toBe("https://highkey.test/reset-password");
    const token = link.searchParams.get("token") as string;
    const reset = (newPassword: string) =>
      authRequest(auth, "/reset-password", { newPassword, token });
    expect((await reset("a password chosen by hand")).status).toBe(200);
    const signedIn = await authRequest(auth, "/sign-in/email", {
      email: "forgetful@example.com",
      password: "a password chosen by hand",
    });
    expect(signedIn.status).toBe(200);
    expect((await reset("another password entirely")).ok).toBe(false);
    expect((await call(ctx, "POST", "/api/admin/users/nobody/reset-link", {})).status).toBe(404);
  });

  test("better_auths_own_admin_endpoints_are_closed", async () => {
    // The server admin works through /api/admin, which keeps Highkey's rules (no impersonation,
    // the deletion rules, reset links rather than setting passwords).
    const auth = await ctx.auth();
    for (const path of [
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
      "/admin/remove-user",
      "/admin/set-user-password",
      "/admin/set-role",
      "/admin/create-user",
      "/admin/update-user",
      "/admin/ban-user",
      "/admin/list-users",
    ]) {
      const response = await authRequest(auth, path, { userId: "x" }, ctx.session);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });
});
