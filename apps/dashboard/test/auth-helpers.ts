// Better Auth on a test context's database, and requests to it as a browser would send them.
import { type Auth, createAuth, type memoryMailer } from "../src/server/auth/auth";
import type { BunDb } from "../src/server/db/bun-db";
import type { TestContext } from "./helpers";

export const TEST_ORIGIN = "https://highkey.test";

export function testAuth(
  ctx: TestContext,
  options: {
    signup?: "open" | "invite";
    mailer?: ReturnType<typeof memoryMailer> | null;
    keyRateLimit?: { timeWindow: number; maxRequests: number };
    cimdFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {},
): Auth {
  return createAuth({
    database: { bun: (ctx.db as BunDb).raw },
    db: ctx.db,
    publicUrl: TEST_ORIGIN,
    secret: "highkey-test-secret-at-least-32-characters",
    mailer: options.mailer === undefined ? null : options.mailer,
    signup: options.signup ?? "open",
    keyRateLimit: options.keyRateLimit,
    cimdFetch: options.cimdFetch,
  });
}

/** POSTs JSON to a Better Auth endpoint, from the dashboard's own origin. */
export function authRequest(
  auth: Auth,
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  return auth.handler(
    new Request(`${TEST_ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** The session cookie a response set, as request headers. */
export function cookieFrom(response: Response): Headers {
  const cookies = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie: cookies });
}

/** Signs someone up and returns their session cookie. */
export async function signUp(auth: Auth, email: string, name = email.split("@")[0] as string) {
  const response = await authRequest(auth, "/sign-up/email", {
    email,
    password: "a password long enough",
    name,
  });
  if (!response.ok)
    throw new Error(`sign up ${email}: ${response.status} ${await response.text()}`);
  return cookieFrom(response);
}

/** Invites `email` into the owner's active organization as `role`; they sign up and accept. */
export async function joinAs(
  auth: Auth,
  owner: Headers,
  email: string,
  role: "owner" | "admin" | "member" | "viewer",
): Promise<Headers> {
  const session = await auth.api.getSession({ headers: owner });
  const organizationId = session?.session.activeOrganizationId as string;
  const invitation = (await auth.api.createInvitation({
    body: { email, role, organizationId },
    headers: owner,
  })) as { id: string };
  const headers = await signUp(auth, email);
  await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers });
  await auth.api.setActiveOrganization({ body: { organizationId }, headers });
  return headers;
}
