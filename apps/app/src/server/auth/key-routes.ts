// /api/keys: a person's API keys in their organization. Everyone lists and revokes their own;
// owners and admins see and revoke everyone's, never the secret, which is shown once at creation.
// Keys are managed from a signed-in session only: a key cannot mint or revoke keys.
import { fields, readJson } from "../api/body";
import { ApiError, bad, json, noContent, unprocessable } from "../api/errors";
import { READ, route } from "../api/router";
import { all, changes } from "../db/db";
import { type Actor, requireActor } from "./actor";
import { keyMetadata } from "./keys";
import { maxAccess, oversees } from "./roles";
import { scopedProject, forbiddenScope } from "./project-access";

export interface ApiKeyListing {
  project_id?: string;
  id: string;
  name: string | null;
  /** The first characters, to tell keys apart. */
  start: string | null;
  access: "read" | "write";
  user: { id: string; name: string; email: string };
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

interface Row {
  id: string;
  name: string | null;
  start: string | null;
  metadata: string | null;
  user_id: string;
  user_name: string;
  user_email: string;
  created_at: string | number;
  expires_at: string | number | null;
  last_used_at: string | number | null;
}

const at = (value: string | number | null) =>
  value === null ? null : new Date(value).toISOString();

function fromSession(actor: Actor): void {
  if (actor.via !== "session")
    throw new ApiError(403, "Manage API keys from a signed-in session", {}, "forbidden");
}

async function listKeys(actor: Actor, db: Parameters<typeof all>[0]): Promise<ApiKeyListing[]> {
  const rows = await all<Row>(
    db,
    `SELECT k.id, k.name, k.start, k.metadata, k."referenceId" AS user_id, u.name AS user_name,
       u.email AS user_email, k."createdAt" AS created_at, k."expiresAt" AS expires_at,
       k."lastRequest" AS last_used_at
     FROM apikey k JOIN "user" u ON u.id = k."referenceId"
     WHERE json_extract(k.metadata, '$.orgId') = ? AND (? OR k."referenceId" = ?)
     ORDER BY k."createdAt", k.id`,
    [actor.orgId, oversees(actor.role) ? 1 : 0, actor.userId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    start: row.start,
    access: keyMetadata(row.metadata)?.access ?? "read",
    ...(keyMetadata(row.metadata)?.projectId
      ? { project_id: keyMetadata(row.metadata)!.projectId }
      : {}),
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
    created_at: at(row.created_at) as string,
    expires_at: at(row.expires_at),
    last_used_at: at(row.last_used_at),
  }));
}

export function registerApiKeys(): void {
  route("GET", "/api/keys", READ, async (_request, ctx) =>
    json(await listKeys(requireActor(ctx), ctx.db)),
  );

  route("POST", "/api/keys", READ, async (request, ctx) => {
    const actor = requireActor(ctx);
    fromSession(actor);
    const input = fields(
      await readJson(request),
      { name: "string", access: "string", expires_in_days: "integer", project_id: "string?" },
      { expires_in_days: 0 },
    );
    const name = input.name.trim();
    if (!name || name.length > 32) throw bad("Use a key name of 1–32 characters");
    if (input.access !== "read" && input.access !== "write")
      throw unprocessable("Use access `read` or `write`");
    if (input.access === "write" && maxAccess(actor.role) === "read")
      throw new ApiError(403, "A viewer can create read-only keys only", {}, "forbidden");
    const scope =
      input.project_id != null ? await scopedProject(ctx, actor, input.project_id) : null;
    if (scope?.access === "read" && input.access === "write") throw forbiddenScope();
    const days = input.expires_in_days;
    if (days !== 0 && (days < 1 || days > 365))
      throw bad("Use expires_in_days 1–365, or leave it out for a key that does not expire");
    const auth = await ctx.auth();
    const created = await auth.api.createApiKey({
      body: {
        name,
        userId: actor.userId,
        metadata: {
          orgId: actor.orgId,
          access: input.access,
          ...(scope ? { projectId: scope.id } : {}),
        },
        ...(days ? { expiresIn: days * 86_400 } : {}),
      },
    });
    return json({
      id: created.id,
      key: created.key,
      name,
      ...(scope ? { project_id: scope.id } : {}),
      access: input.access,
      expires_at: created.expiresAt ? new Date(created.expiresAt).toISOString() : null,
    });
  });

  route("DELETE", "/api/keys/:key", READ, async (_request, ctx, { key }) => {
    const actor = requireActor(ctx);
    fromSession(actor);
    const removed = await changes(
      ctx.db,
      `DELETE FROM apikey WHERE id = ? AND json_extract(metadata, '$.orgId') = ?
         AND (? OR "referenceId" = ?)`,
      [key as string, actor.orgId, oversees(actor.role) ? 1 : 0, actor.userId],
    );
    if (removed === 0) throw new ApiError(404, "API key not found", {}, "not_found");
    return noContent();
  });
}
