// Who is asking: every /api request resolves to an actor in one organization, with the role it
// holds there right now (read from `member` on each request, so a removal or demotion counts at
// once). Sessions come from Better Auth's cookie, API keys from `Authorization` or `X-Api-Key`.
import type { ApiContext } from "../api/context";
import { ApiError } from "../api/errors";
import { one } from "../db/db";
import { keyFrom, keyMetadata } from "./keys";
import { isRole, maxAccess, type Role } from "./roles";

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

/**
 * The actor behind an API key: its maker, in the key's organization, with the key's access capped
 * by the role the maker holds there now. Keys never act as the server admin.
 */
async function keyActor(ctx: ApiContext, key: string): Promise<Actor> {
  const auth = await ctx.auth();
  const result = await auth.api.verifyApiKey({ body: { key } });
  if (result.error?.code === "RATE_LIMITED")
    throw new ApiError(
      429,
      "This API key made too many requests; wait a minute and try again",
      { "retry-after": "60" },
      "rate_limited",
    );
  const meta = result.valid ? keyMetadata(result.key?.metadata) : null;
  const userId = result.key?.referenceId;
  if (!meta || !userId)
    throw new ApiError(401, "This API key is not valid or has expired", {}, "unauthenticated");
  const role = await memberRole(ctx, meta.orgId, userId);
  if (!role)
    throw new ApiError(
      403,
      "This key's owner is no longer a member of its organization",
      {},
      "not_a_member",
    );
  return {
    userId,
    orgId: meta.orgId,
    role,
    access: meta.access === "write" ? maxAccess(role) : "read",
    via: "key",
    serverAdmin: false,
  };
}

export async function resolveActor(ctx: ApiContext, request: Request): Promise<Actor> {
  const key = keyFrom(request.headers);
  if (key) return keyActor(ctx, key);
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
