import { defineChannel } from "tako.sh";
import type { ChangeEnvelope } from "../lib/change-envelope";
import { sessionCookieName } from "../server/auth/cookie";

// One stream of live hints per organization, for its members only: the session cookie, or one of
// the organization's API keys as a bearer token. Hints have no replay history: reconnecting
// clients query the API to catch up.
export default defineChannel("analytics-changes", {
  ephemeral: true,
  paramsSchema: (t) => t.Object({ org: t.String({ minLength: 1, maxLength: 64 }) }),
  auth: {
    headerName: "authorization",
    cookieName: sessionCookieName(process.env.HIGHKEY_PUBLIC_URL ?? "http://127.0.0.1:3000"),
    async verify({ params, cookie, header }) {
      const [{ verifyChannel }, { apiContext }] = await Promise.all([
        import("../server/live-auth"),
        import("../server/api/context"),
      ]);
      return verifyChannel(apiContext(), { params, cookie, header });
    },
  },
}).$messageTypes<{ changed: ChangeEnvelope }>();
