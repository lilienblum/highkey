// Email through Resend (verification, password reset, invitations), invitation links without
// email, TOTP two-factor codes and an organization's two-factor requirement, and GitHub/Google
// sign-in when configured.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Auth } from "../src/server/auth/auth";
import { memoryMailer, resendMailer, socialFromEnv } from "../src/server/auth/mailer";
import { authRequest, cookieFrom, joinAs, signUp, TEST_ORIGIN, testAuth } from "./auth-helpers";
import { call, type TestContext, testContext } from "./helpers";
import { totpCode } from "./totp";

const PASSWORD = "a password long enough";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext({ signedIn: false });
}, 300_000);
afterEach(() => ctx?.cleanup());

const link = (text: string, path: string) =>
  new RegExp(`https://\\S*${path}\\S*`).exec(text)?.[0] as string;

/**
 * Turns on two-factor codes for a signed-in person. Returns their authenticator URI and their
 * session from then on (turning codes on replaces the session).
 */
async function enableTotp(auth: Auth, who: Headers): Promise<{ uri: string; session: Headers }> {
  const enabled = await authRequest(auth, "/two-factor/enable", { password: PASSWORD }, who);
  expect(enabled.status).toBe(200);
  const { totpURI } = (await enabled.json()) as { totpURI: string };
  const confirmed = await authRequest(
    auth,
    "/two-factor/verify-totp",
    { code: totpCode(totpURI) },
    who,
  );
  expect(confirmed.status).toBe(200);
  const renewed = cookieFrom(confirmed);
  return { uri: totpURI, session: renewed.get("cookie") ? renewed : who };
}

describe("email and two-factor", () => {
  test("with_resend_sign_up_needs_verification_and_sends_one_email", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init as RequestInit });
      return Response.json({ id: "email-1" });
    };
    const mailer = resendMailer("re_test_key", "Highkey <hello@highkey.example>", fetchImpl);
    const auth = testAuth(ctx, { mailer, signup: "open" });
    const signedUp = await authRequest(auth, "/sign-up/email", {
      email: "ada@example.com",
      password: PASSWORD,
      name: "Ada",
    });
    expect(signedUp.status).toBe(200);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer re_test_key");
    const email = JSON.parse(String(request?.init.body)) as Record<string, unknown>;
    expect(email).toMatchObject({
      from: "Highkey <hello@highkey.example>",
      to: ["ada@example.com"],
      subject: expect.stringContaining("Verify"),
    });
    expect(email.html).toBeUndefined();
    const early = await authRequest(auth, "/sign-in/email", {
      email: "ada@example.com",
      password: PASSWORD,
    });
    expect(early.status).toBe(403);
    // Signing in unverified sends a fresh link, so an expired one is never a dead end.
    expect(requests).toHaveLength(2);
    const verify = link(String(email.text), "verify-email");
    expect(verify).toStartWith(`${TEST_ORIGIN}/api/auth/verify-email?token=`);
    await auth.handler(new Request(verify));
    const signedIn = await authRequest(auth, "/sign-in/email", {
      email: "ada@example.com",
      password: PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    // A failed send is an error, not a silent success.
    const failing = resendMailer("re_test_key", "hello@highkey.example", async () =>
      Response.json({ message: "invalid" }, { status: 422 }),
    );
    expect(failing.send({ to: "x@example.com", subject: "s", text: "t" })).rejects.toThrow();
  });

  test("without_resend_invitations_return_a_copyable_link", async () => {
    const auth = testAuth(ctx);
    const owner = await signUp(auth, "owner@example.com");
    const invited = await authRequest(
      auth,
      "/organization/invite-member",
      { email: "guest@example.com", role: "member" },
      owner,
    );
    expect(invited.status).toBe(200);
    const invitation = (await invited.json()) as { id: string; link: string };
    expect(invitation.link).toBe(`${TEST_ORIGIN}/join/${invitation.id}`);
    // With email, the same link goes to the invitee.
    const mailer = memoryMailer();
    const mailing = testAuth(ctx, { mailer });
    const second = (await (
      await authRequest(
        mailing,
        "/organization/invite-member",
        { email: "pal@example.com", role: "viewer" },
        owner,
      )
    ).json()) as { link: string };
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("pal@example.com");
    expect(mailer.sent[0]?.text).toContain(second.link);
    expect(mailer.sent[0]?.text).toContain("viewer");
  });

  test("password_reset_email_signs_in_with_the_new_password", async () => {
    const mailer = memoryMailer();
    const auth = testAuth(ctx, { mailer });
    await authRequest(auth, "/sign-up/email", {
      email: "lin@example.com",
      password: PASSWORD,
      name: "Lin",
    });
    await auth.handler(new Request(link(mailer.sent[0]?.text as string, "verify-email")));
    const requested = await authRequest(auth, "/request-password-reset", {
      email: "lin@example.com",
      redirectTo: "/reset-password",
    });
    expect(requested.status).toBe(200);
    const email = mailer.sent[1];
    expect(email?.subject).toContain("password");
    const token = /reset-password\/([^?\s]+)/.exec(email?.text as string)?.[1] as string;
    const reset = await authRequest(auth, "/reset-password", {
      newPassword: "a brand new long password",
      token,
    });
    expect(reset.status).toBe(200);
    const signIn = (password: string) =>
      authRequest(auth, "/sign-in/email", { email: "lin@example.com", password });
    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn("a brand new long password")).status).toBe(200);
  });

  test("totp_sign_in_requires_a_code_after_enabling", async () => {
    const auth = testAuth(ctx);
    const who = await signUp(auth, "tess@example.com");
    const { uri } = await enableTotp(auth, who);
    expect(uri).toContain("issuer=Highkey");
    const first = await authRequest(auth, "/sign-in/email", {
      email: "tess@example.com",
      password: PASSWORD,
    });
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    const pending = cookieFrom(first);
    expect(await auth.api.getSession({ headers: pending })).toBeNull();
    const wrong = await authRequest(auth, "/two-factor/verify-totp", { code: "000000" }, pending);
    expect(wrong.ok).toBe(false);
    const verified = await authRequest(
      auth,
      "/two-factor/verify-totp",
      { code: totpCode(uri) },
      pending,
    );
    expect(verified.status).toBe(200);
    const session = await auth.api.getSession({ headers: cookieFrom(verified) });
    expect(session?.user.email).toBe("tess@example.com");
  });

  test("an_organization_requiring_two_factor_refuses_members_without_it", async () => {
    const auth = testAuth(ctx);
    ctx.auth = async () => auth;
    let owner = await signUp(auth, "owner@example.com");
    let member = await joinAs(auth, owner, "member@example.com", "member");
    const require = () =>
      authRequest(auth, "/organization/update", { data: { requireTwoFactor: true } }, owner);
    // Turning it on without two-factor yourself would lock you out.
    const refused = await require();
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toContain("two-factor");
    owner = (await enableTotp(auth, owner)).session;
    expect((await require()).status).toBe(200);
    const as = (who: Headers) => ({ cookie: who.get("cookie") as string });
    expect((await call(ctx, "GET", "/api/products", undefined, as(owner))).status).toBe(200);
    const blocked = await call(ctx, "GET", "/api/products", undefined, as(member));
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("two_factor_required");
    member = (await enableTotp(auth, member)).session;
    expect((await call(ctx, "GET", "/api/products", undefined, as(member))).status).toBe(200);
  });

  test("social_providers_appear_only_when_configured", async () => {
    expect(socialFromEnv({})).toEqual({});
    expect(socialFromEnv({ HIGHKEY_GITHUB_CLIENT_ID: "id" })).toEqual({});
    expect(
      socialFromEnv({
        HIGHKEY_GITHUB_CLIENT_ID: "gh-id",
        HIGHKEY_GITHUB_CLIENT_SECRET: "gh-secret",
        HIGHKEY_GOOGLE_CLIENT_ID: "google-id",
      }),
    ).toEqual({ github: { clientId: "gh-id", clientSecret: "gh-secret" } });
    const auth = testAuth(ctx, {
      social: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    });
    const github = await authRequest(auth, "/sign-in/social", {
      provider: "github",
      callbackURL: "/",
    });
    expect(github.status).toBe(200);
    expect(((await github.json()) as { url: string }).url).toStartWith(
      "https://github.com/login/oauth/authorize",
    );
    const google = await authRequest(auth, "/sign-in/social", {
      provider: "google",
      callbackURL: "/",
    });
    expect(google.ok).toBe(false);
  });
});
