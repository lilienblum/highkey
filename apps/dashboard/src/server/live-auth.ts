// Who may subscribe to an organization's live hints: a signed-in member of that organization. The
// channel hands over the session cookie's value; the session and membership are checked as for
// any API request.
import type { ApiContext } from "./api/context";
import { memberRole } from "./auth/actor";
import { sessionCookieName } from "./auth/cookie";

export async function verifyChannel(
  ctx: ApiContext,
  input: { params: { org?: unknown }; cookie?: string },
): Promise<false | { subject: string }> {
  const org = input.params.org;
  if (!input.cookie || typeof org !== "string") return false;
  const auth = await ctx.auth();
  const cookie = `${sessionCookieName(ctx.publicUrl)}=${input.cookie}`;
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
  if (!session) return false;
  return (await memberRole(ctx, org, session.user.id)) ? { subject: session.user.id } : false;
}
