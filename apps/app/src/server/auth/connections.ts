// Agent connections: each OAuth grant a person gave an agent for one organization (its consent),
// listed under Organization settings → Agents. Everyone sees and revokes their own; owners and admins see and
// revoke everyone's in the organization. Revoking deletes the grant and the agent's tokens, and
// since every request checks the grant, an access token stops working at once.
import { ApiError, json, noContent } from "../api/errors";
import { READ, route } from "../api/router";
import type { ApiContext } from "../api/context";
import { all, changes, one } from "../db/db";
import { type Actor, requireActor } from "./actor";
import { oversees } from "./roles";

export interface Connection {
  id: string;
  client: { id: string; name: string | null };
  user: { id: string; name: string; email: string };
  access: "read" | "write";
  created_at: string;
  /** When the agent last got a token for this grant (it refreshes while in use). */
  last_used_at: string;
}

interface Row {
  id: string;
  client_id: string;
  client_name: string | null;
  user_id: string;
  user_name: string;
  user_email: string;
  scopes: string;
  created_at: string | number;
  last_used_at: string | number | null;
}

const at = (value: string | number) => new Date(value).toISOString();

function scopesOf(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return text.split(" ");
  }
}

export async function listConnections(ctx: ApiContext, actor: Actor): Promise<Connection[]> {
  const rows = await all<Row>(
    ctx.db,
    `SELECT c.id, c."clientId" AS client_id, cl.name AS client_name, c."userId" AS user_id,
       u.name AS user_name, u.email AS user_email, c.scopes, c."createdAt" AS created_at,
       (SELECT max(t."createdAt") FROM "oauthRefreshToken" t
         WHERE t."clientId" = c."clientId" AND t."userId" = c."userId"
           AND t."referenceId" = c."referenceId") AS last_used_at
     FROM "oauthConsent" c
     JOIN "oauthClient" cl ON cl."clientId" = c."clientId"
     JOIN "user" u ON u.id = c."userId"
     WHERE c."referenceId" = ? AND (? OR c."userId" = ?)
     ORDER BY c."createdAt", c.id`,
    [actor.orgId, oversees(actor.role) ? 1 : 0, actor.userId],
  );
  return rows.map((row) => ({
    id: row.id,
    client: { id: row.client_id, name: row.client_name },
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
    access: scopesOf(row.scopes).includes("mcp:write") ? "write" : "read",
    created_at: at(row.created_at),
    last_used_at: at(row.last_used_at ?? row.created_at),
  }));
}

/** Revokes a grant in the actor's organization (their own, or anyone's for owners and admins). */
export async function revokeConnection(ctx: ApiContext, actor: Actor, id: string): Promise<void> {
  const found = await ctx.db.transaction(async (tx) => {
    const grant = await one<{ client_id: string; user_id: string }>(
      tx,
      `SELECT "clientId" AS client_id, "userId" AS user_id FROM "oauthConsent"
       WHERE id = ? AND "referenceId" = ? AND (? OR "userId" = ?)`,
      [id, actor.orgId, oversees(actor.role) ? 1 : 0, actor.userId],
    );
    if (!grant) return false;
    const owner = [grant.client_id, grant.user_id, actor.orgId];
    const where = `"clientId" = ? AND "userId" = ? AND "referenceId" = ?`;
    await tx.execute(`DELETE FROM "oauthAccessToken" WHERE ${where}`, owner);
    await tx.execute(`DELETE FROM "oauthRefreshToken" WHERE ${where}`, owner);
    return (await changes(tx, `DELETE FROM "oauthConsent" WHERE id = ?`, [id])) === 1;
  });
  if (!found) throw new ApiError(404, "Connection not found", {}, "not_found");
}

export function registerConnections(): void {
  route("GET", "/api/connections", READ, async (_request, ctx) =>
    json(await listConnections(ctx, requireActor(ctx))),
  );
  route("DELETE", "/api/connections/:key", READ, async (_request, ctx, { key }) => {
    const actor = requireActor(ctx);
    if (actor.via !== "session")
      throw new ApiError(403, "Manage agent connections from a signed-in session", {}, "forbidden");
    await revokeConnection(ctx, actor, key as string);
    return noContent();
  });
}
