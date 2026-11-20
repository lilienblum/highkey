// /api/admin: the server admin's tools, above every organization. Better Auth's admin plugin does
// the banning and session work (as the admin, with their own session); a reset link is a
// one-time password-reset token the admin hands over when there is no email.
import { randomBytes } from "node:crypto";
import { ApiError, bad, json } from "./api/errors";
import { readJson } from "./api/body";
import { route } from "./api/router";
import type { ApiContext } from "./api/context";
import { requireActor } from "./auth/actor";
import { all, one } from "./db/db";

/** How long a hand-over reset link works. */
const RESET_LINK_SECONDS = 24 * 60 * 60;

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: number | null;
  ban_reason: string | null;
  two_factor: number | null;
  created_at: string | number;
}

const pattern = (request: Request) =>
  `%${(new URL(request.url).searchParams.get("search") ?? "").trim().replace(/[\\%_]/g, "\\$&")}%`;

async function existingUser(ctx: ApiContext, id: string): Promise<string> {
  const row = await one<{ id: string }>(ctx.db, 'SELECT id FROM "user" WHERE id = ?', [id]);
  if (!row) throw new ApiError(404, "User not found", {}, "not_found");
  return row.id;
}

async function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    const message = (error as { body?: { message?: string } }).body?.message;
    if (status && message) throw new ApiError(status, message);
    throw error;
  }
}

export function registerAdmin(): void {
  route("GET", "/api/admin/users", "server-admin", async (request, ctx) => {
    const rows = await all<UserRow>(
      ctx.db,
      `SELECT id, name, email, role, banned, "banReason" AS ban_reason,
         "twoFactorEnabled" AS two_factor, "createdAt" AS created_at
       FROM "user" WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\'
       ORDER BY "createdAt", id LIMIT 200`,
      [pattern(request)],
    );
    return json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role ?? "user",
        banned: Boolean(row.banned),
        ban_reason: row.ban_reason,
        two_factor: Boolean(row.two_factor),
        created_at: new Date(row.created_at).toISOString(),
      })),
    );
  });

  route("GET", "/api/admin/organizations", "server-admin", async (request, ctx) =>
    json(
      (
        await all<{
          id: string;
          name: string;
          slug: string;
          members: number;
          projects: number;
          created_at: string | number;
        }>(
          ctx.db,
          `SELECT o.id, o.name, o.slug,
             (SELECT count(*) FROM member m WHERE m."organizationId" = o.id) AS members,
             (SELECT count(*) FROM products p WHERE p.org_id = o.id) AS projects,
             o."createdAt" AS created_at
           FROM organization o WHERE o.name LIKE ?1 ESCAPE '\\' OR o.slug LIKE ?1 ESCAPE '\\'
           ORDER BY o."createdAt", o.id LIMIT 200`,
          [pattern(request)],
        )
      ).map((row) => ({
        ...row,
        members: Number(row.members),
        projects: Number(row.projects),
        created_at: new Date(row.created_at).toISOString(),
      })),
    ),
  );

  route("POST", "/api/admin/users/:key/ban", "server-admin", async (request, ctx, { key }) => {
    const userId = await existingUser(ctx, key as string);
    if (userId === requireActor(ctx).userId) throw bad("You cannot ban yourself");
    const body = (await readJson(request).catch(() => ({}))) as { reason?: unknown };
    const auth = await ctx.auth();
    await asAdmin(() =>
      auth.api.banUser({
        body: {
          userId,
          ...(typeof body.reason === "string" && body.reason ? { banReason: body.reason } : {}),
        },
        headers: request.headers,
      }),
    );
    return json({ banned: true });
  });

  route("POST", "/api/admin/users/:key/unban", "server-admin", async (request, ctx, { key }) => {
    const userId = await existingUser(ctx, key as string);
    const auth = await ctx.auth();
    await asAdmin(() => auth.api.unbanUser({ body: { userId }, headers: request.headers }));
    return json({ banned: false });
  });

  route(
    "POST",
    "/api/admin/users/:key/revoke-sessions",
    "server-admin",
    async (request, ctx, { key }) => {
      const userId = await existingUser(ctx, key as string);
      const auth = await ctx.auth();
      await asAdmin(() =>
        auth.api.revokeUserSessions({ body: { userId }, headers: request.headers }),
      );
      return json({ revoked: true });
    },
  );

  // A one-time link to the reset page, for the admin to hand over when there is no email.
  route(
    "POST",
    "/api/admin/users/:key/reset-link",
    "server-admin",
    async (_request, ctx, { key }) => {
      const userId = await existingUser(ctx, key as string);
      const token = randomBytes(24).toString("base64url");
      const context = await (await ctx.auth()).$context;
      await context.internalAdapter.createVerificationValue({
        value: userId,
        identifier: `reset-password:${token}`,
        expiresAt: new Date(Date.now() + RESET_LINK_SECONDS * 1000),
      });
      const link = new URL("/reset-password", new URL(ctx.publicUrl).origin);
      link.searchParams.set("token", token);
      return json({ link: link.toString(), expires_in: RESET_LINK_SECONDS });
    },
  );
}
