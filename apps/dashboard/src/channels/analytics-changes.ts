import { defineChannel } from "tako.sh";
import type { ChangeEnvelope } from "../lib/change-envelope";
import { sessionCookieName } from "../server/auth/cookie";

// One stream of live hints per organization, for its members only (checked with the session
// cookie). Hints have no replay history: reconnecting clients query the API to catch up.
export default defineChannel("analytics-changes", {
  ephemeral: true,
  paramsSchema: (t) => t.Object({ org: t.String({ minLength: 1, maxLength: 64 }) }),
  auth: {
    headerName: false,
    cookieName: sessionCookieName(process.env.HIGHKEY_PUBLIC_URL ?? "http://127.0.0.1:3000"),
    async verify({ params, cookie }) {
      const [{ verifyChannel }, { apiContext }] = await Promise.all([
        import("../server/live-auth"),
        import("../server/api/context"),
      ]);
      return verifyChannel(apiContext(), { params, cookie });
    },
  },
}).$messageTypes<{ changed: ChangeEnvelope }>();
