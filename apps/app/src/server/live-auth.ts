// Who may subscribe to an organization's live hints: a member of that organization, signed in
// (the session cookie) or holding one of its API keys (`Authorization: Bearer hk_…`), checked as
// for any API request.
import type { ApiContext } from "./api/context";
import { memberRole, resolveActor } from "./auth/actor";
import { sessionCookieName } from "./auth/cookie";
import { KEY_PREFIX } from "./auth/keys";
import { grants } from "./auth/project-access";

export async function verifyChannel(
  ctx: ApiContext,
  input: {
    params: { org?: unknown };
    cookie?: string;
    header?: { scheme?: string; value: string };
  },
): Promise<false | { subject: string }> {
  const org = input.params.org;
  if (typeof org !== "string") return false;
  const key = input.header?.value;
  if (key?.startsWith(KEY_PREFIX)) {
    const request = new Request("http://localhost/", {
      headers: { authorization: `Bearer ${key}` },
    });
    const actor = await resolveActor(ctx, request).catch(() => null);
    return actor && !actor.tokenProject && !actor.projects && actor.orgId === org
      ? { subject: actor.userId }
      : false;
  }
  if (!input.cookie) return false;
  const auth = await ctx.auth();
  const cookie = `${sessionCookieName(ctx.publicUrl)}=${input.cookie}`;
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
  if (!session) return false;
  const role = await memberRole(ctx, org, session.user.id);
  return role && !(await grants(ctx.db, org, session.user.id, role))
    ? { subject: session.user.id }
    : false;
}
