// Who is asking: every /api request resolves to an actor in one organization, with the role it
// holds there right now (read from `member` on each request, so a removal or demotion counts at
// once). Sessions come from Better Auth's cookie, API keys from `Authorization` or `X-Api-Key`,
// and agents' OAuth access tokens (on /mcp only) from `Authorization`.
import { requireMcpAuth } from "@better-auth/mcp";
import type { ApiContext } from "../api/context";
import { ApiError } from "../api/errors";
import { one, StorageUnavailable } from "../db/db";
import { mcpResource } from "./auth";
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

/**
 * The role `userId` holds in `orgId`, for a request acting there: refused when they are not a
 * member, when they are banned, or when the organization requires two-factor codes and they
 * have not turned them on.
 */
async function standing(ctx: ApiContext, orgId: string, userId: string, notMember: string) {
  const role = await memberRole(ctx, orgId, userId);
  if (!role) throw new ApiError(403, notMember, {}, "not_a_member");
  const row = await one<{
    required: number | null;
    enabled: number | null;
    banned: number | null;
  }>(
    ctx.db,
    'SELECT o."requireTwoFactor" AS required, u."twoFactorEnabled" AS enabled, u.banned FROM organization o, "user" u WHERE o.id = ? AND u.id = ?',
    [orgId, userId],
  );
  // A banned person's sessions are gone; their keys and agent tokens stop here.
  if (row?.banned) throw new ApiError(403, "This account is banned", {}, "banned");
  if (row?.required && !row.enabled)
    throw new ApiError(
      403,
      "This organization requires two-factor codes; turn them on in your account settings",
      {},
      "two_factor_required",
    );
  return role;
}

/**
 * Throws `StorageUnavailable` when the management database cannot be reached. Better Auth reads
 * the same database through its own connection and reports an outage as its own 500 or as an
 * invalid credential; before answering that way, Highkey asks its own connection, so an outage
 * answers 503 with Retry-After instead of sending people to sign in or agents to re-authorize.
 */
export async function failIfStorageDown(ctx: ApiContext): Promise<void> {
  try {
    await ctx.db.execute("SELECT 1");
  } catch (error) {
    if (error instanceof StorageUnavailable) throw error;
  }
}

/** The header the dashboard sends with the organization of the page making the request. */
export const ORGANIZATION_HEADER = "x-highkey-organization";

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
  const result = await auth.api.verifyApiKey({ body: { key } }).catch(async (error) => {
    await failIfStorageDown(ctx);
    throw error;
  });
  if (result.error?.code === "RATE_LIMITED")
    throw new ApiError(
      429,
      "This API key made too many requests; wait a minute and try again",
      { "retry-after": "60" },
      "rate_limited",
    );
  const meta = result.valid ? keyMetadata(result.key?.metadata) : null;
  const userId = result.key?.referenceId;
  if (!meta || !userId) {
    // The plugin reports a failed lookup as an invalid key.
    await failIfStorageDown(ctx);
    throw new ApiError(401, "This API key is not valid or has expired", {}, "unauthenticated");
  }
  const role = await standing(
    ctx,
    meta.orgId,
    userId,
    "This key's owner is no longer a member of its organization",
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
  const session = await auth.api.getSession({ headers: request.headers }).catch(async (error) => {
    await failIfStorageDown(ctx);
    throw error;
  });
  if (!session) throw new ApiError(401, "Sign in to use Highkey", {}, "unauthenticated");
  // The dashboard names the organization of the page that sent the request; without it (other
  // clients), the session's open organization. Either way the person must belong to it.
  const orgId =
    request.headers.get(ORGANIZATION_HEADER)?.trim() || session.session.activeOrganizationId;
  if (!orgId)
    throw new ApiError(403, "Join or create an organization first", {}, "no_organization");
  const role = await standing(
    ctx,
    orgId,
    session.user.id,
    "You are no longer a member of this organization",
  );
  return {
    userId: session.user.id,
    orgId,
    role,
    access: "write",
    via: "session",
    serverAdmin: (session.user as { role?: string | null }).role === "admin",
  };
}

/**
 * The actor behind an agent's OAuth access token: the person who granted it, in the organization
 * it names, while that grant still stands and they still belong there. `mcp:write` grants the
 * changing tools, capped by the person's role.
 */
type Claims = Parameters<Parameters<typeof requireMcpAuth>[1]>[1];

export async function tokenActor(ctx: ApiContext, claims: Claims): Promise<Actor> {
  const userId = claims.sub;
  const clientId = typeof claims.azp === "string" ? claims.azp : null;
  const orgId = typeof claims.org === "string" ? claims.org : null;
  const scopes = new Set(String(claims.scope ?? "").split(" "));
  const revoked = new ApiError(
    401,
    "This connection was revoked; connect the agent again",
    { "www-authenticate": 'Bearer error="invalid_token"' },
    "unauthenticated",
  );
  if (!userId || !clientId || !orgId) throw revoked;
  if (!scopes.has("mcp:read") && !scopes.has("mcp:write"))
    throw new ApiError(
      403,
      "This token was not granted access to Highkey's tools",
      {},
      "forbidden",
    );
  const granted = await one(
    ctx.db,
    'SELECT 1 AS found FROM "oauthConsent" WHERE "userId" = ? AND "clientId" = ? AND "referenceId" = ?',
    [userId, clientId, orgId],
  );
  if (!granted) throw revoked;
  const role = await standing(
    ctx,
    orgId,
    userId,
    "This connection's person is no longer a member of its organization",
  );
  return {
    userId,
    orgId,
    role,
    access: scopes.has("mcp:write") ? maxAccess(role) : "read",
    via: "mcp",
    serverAdmin: false,
  };
}

/**
 * Runs `proceed` as the agent whose access token the request carries. Without a valid token the
 * answer is a 401 whose `WWW-Authenticate` points at the protected-resource metadata, which is
 * how an MCP client learns to start the OAuth flow.
 */
export async function withAccessToken(
  ctx: ApiContext,
  request: Request,
  proceed: (actor: Actor) => Promise<Response>,
): Promise<Response> {
  const auth = await ctx.auth();
  const response = await requireMcpAuth(
    auth,
    async (_request, claims) => proceed(await tokenActor(ctx, claims)),
    { resource: mcpResource(ctx.publicUrl) },
  )(request).catch(async (error) => {
    await failIfStorageDown(ctx);
    throw error;
  });
  // A token that could not be checked (the signing keys live in the database) reads as invalid.
  if (response.status === 401) await failIfStorageDown(ctx);
  return response;
}
