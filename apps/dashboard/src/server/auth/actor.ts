// Who is asking: every /api request resolves to an actor in one organization, with the role it
// holds there right now (read from `member` on each request, so a removal or demotion counts at
// once). Sessions come from Better Auth's cookie; API keys and agent tokens are added later.
import type { ApiContext } from "../api/context";
import { ApiError } from "../api/errors";
import { one } from "../db/db";
import { isRole, type Role } from "./roles";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
  /** What the credential allows; a session allows what the role does. */
  access: "read" | "write";
  via: "session" | "key" | "mcp";
  /** The server admin, above every organization. */
  serverAdmin: boolean;
}

/** The strongest of a member's roles (Better Auth stores several comma-separated). */
function strongest(roles: string): Role | null {
  const order: Role[] = ["owner", "admin", "member", "viewer"];
  const held = roles.split(",").map((r) => r.trim());
  return order.find((r) => held.includes(r)) ?? null;
}

/** The role `userId` holds in `orgId` now, or null when they are not a member. */
export async function memberRole(ctx: ApiContext, orgId: string, userId: string) {
  const row = await one<{ role: string }>(
    ctx.db,
    'SELECT role FROM member WHERE "organizationId" = ? AND "userId" = ?',
    [orgId, userId],
  );
  const role = row ? strongest(row.role) : null;
  return role && isRole(role) ? role : null;
}

/** The actor the router resolved for this request; handlers behind the router always have one. */
export function requireActor(ctx: ApiContext): Actor {
  if (!ctx.actor) throw new ApiError(401, "Sign in to use Highkey", {}, "unauthenticated");
  return ctx.actor;
}

export async function resolveActor(ctx: ApiContext, request: Request): Promise<Actor> {
  const auth = await ctx.auth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new ApiError(401, "Sign in to use Highkey", {}, "unauthenticated");
  const orgId = session.session.activeOrganizationId;
  if (!orgId)
    throw new ApiError(403, "Join or create an organization first", {}, "no_organization");
  const role = await memberRole(ctx, orgId, session.user.id);
  if (!role)
    throw new ApiError(403, "You are no longer a member of this organization", {}, "not_a_member");
  return {
    userId: session.user.id,
    orgId,
    role,
    access: "write",
    via: "session",
    serverAdmin: (session.user as { role?: string | null }).role === "admin",
  };
}
