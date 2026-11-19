// Better Auth on a test context's database, and requests to it as a browser would send them.
import { type Auth, createAuth, type memoryMailer } from "../src/server/auth/auth";
import type { BunDb } from "../src/server/db/bun-db";
import type { TestContext } from "./helpers";

export const TEST_ORIGIN = "http://highkey.test";

export function testAuth(
  ctx: TestContext,
  options: { signup?: "open" | "invite"; mailer?: ReturnType<typeof memoryMailer> | null } = {},
): Auth {
  return createAuth({
    database: { bun: (ctx.db as BunDb).raw },
    publicUrl: TEST_ORIGIN,
    secret: "highkey-test-secret-at-least-32-characters",
    mailer: options.mailer === undefined ? null : options.mailer,
    signup: options.signup ?? "open",
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
