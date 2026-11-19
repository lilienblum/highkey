import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAuth } from "../src/server/auth/auth";
import type { BunDb } from "../src/server/db/bun-db";
import { type TestContext, testContext } from "./helpers";
import { authRequest, cookieFrom, testAuth } from "./auth-helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await testContext();
}, 300_000);
afterAll(() => ctx?.cleanup());

describe("accounts", () => {
  test("sign_up_then_sign_in_issues_a_session", async () => {
    const auth = testAuth(ctx);
    const signUp = await authRequest(auth, "/sign-up/email", {
      email: "ada@example.com",
      password: "correct horse battery",
      name: "Ada",
    });
    expect(signUp.status).toBe(200);
    const signIn = await authRequest(auth, "/sign-in/email", {
      email: "ada@example.com",
      password: "correct horse battery",
    });
    expect(signIn.status).toBe(200);
    const session = await auth.api.getSession({ headers: cookieFrom(signIn) });
    expect(session?.user.email).toBe("ada@example.com");
  });

  test("a_wrong_password_is_refused", async () => {
    const auth = testAuth(ctx);
    await authRequest(auth, "/sign-up/email", {
      email: "grace@example.com",
      password: "a long enough secret",
      name: "Grace",
    });
    const refused = await authRequest(auth, "/sign-in/email", {
      email: "grace@example.com",
      password: "not the password",
    });
    expect(refused.status).toBe(401);
  });

  test("sessions_survive_a_restart_on_the_same_database", async () => {
    const before = testAuth(ctx);
    const signUp = await authRequest(before, "/sign-up/email", {
      email: "linus@example.com",
      password: "another long secret",
      name: "Linus",
    });
    // A new process: a fresh instance on the same database and secret.
    const after = createAuth({
      database: { bun: (ctx.db as BunDb).raw },
      publicUrl: "http://highkey.test",
      secret: "highkey-test-secret-at-least-32-characters",
      mailer: null,
      signup: "open",
    });
    const session = await after.api.getSession({ headers: cookieFrom(signUp) });
    expect(session?.user.email).toBe("linus@example.com");
  });
});
