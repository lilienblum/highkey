// Deleting projects and people. A deleted project disappears from every page and tool and its
// keys stop at once (mirrored as revoked); an admin can restore it for 7 days, and after that the
// reconcile enqueues its wipe (wipe.ts). A person cannot be deleted while they are the only owner
// of an organization that has other members; organizations where they are the only member go
// with them, their projects by the project rule.
import { ApiError, bad, json, noContent } from "./api/errors";
import type { ApiContext } from "./api/context";
import { type Need, route } from "./api/router";
import { requireActor } from "./auth/actor";
import { forgetOrganization, projectCount } from "./auth/org-cleanup";
import { all, changes, one } from "./db/db";
import { now } from "./db/ids";
import { type Product, product } from "./db/products";
import { afterCommit, mirrorProject } from "./registry";
import { graceCutoff, RESTORE_DAYS } from "./wipe";

const DELETE: Need = { project: ["delete"] };

/** Hides a project and stops its keys; false when it was already deleted. */
async function softDelete(ctx: ApiContext, id: string): Promise<boolean> {
  const deleted =
    (await changes(
      ctx.db,
      "UPDATE products SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      [now(), id],
    )) === 1;
  if (!deleted) return false;
  await afterCommit(() => mirrorProject(ctx, id));
  ctx.changes.notify(id, "dashboards");
  return true;
}

export async function deleteProject(ctx: ApiContext, id: string): Promise<void> {
  if (!(await softDelete(ctx, id))) throw new ApiError(404, "Project not found", {}, "not_found");
}

export interface DeletedProject {
  id: string;
  name: string;
  slug: string;
  deleted_at: string;
  restorable_until: string;
}

export async function listDeletedProjects(
  ctx: ApiContext,
  orgId: string,
): Promise<DeletedProject[]> {
  const rows = await all<{ id: string; name: string; slug: string; deleted_at: string }>(
    ctx.db,
    "SELECT id, name, slug, deleted_at FROM products WHERE org_id = ? AND deleted_at > ? ORDER BY deleted_at DESC, id",
    [orgId, graceCutoff(ctx.now())],
  );
  return rows.map((row) => ({
    ...row,
    restorable_until: new Date(
      new Date(row.deleted_at).getTime() + RESTORE_DAYS * 86_400_000,
    ).toISOString(),
  }));
}

/** Brings back a project of `orgId` deleted less than 7 days ago, keys and all. */
export async function restoreProject(ctx: ApiContext, orgId: string, id: string): Promise<Product> {
  const restored = await changes(
    ctx.db,
    "UPDATE products SET deleted_at = NULL WHERE id = ? AND org_id = ? AND deleted_at > ?",
    [id, orgId, graceCutoff(ctx.now())],
  );
  if (restored === 0)
    throw new ApiError(
      404,
      "No deleted project to restore here; projects can be restored for 7 days",
      {},
      "not_found",
    );
  await afterCommit(() => mirrorProject(ctx, id));
  ctx.changes.notify(id, "dashboards");
  return product(ctx.db, id);
}

/**
 * Checks that `userId` may be deleted, then deletes the projects of the organizations where they
 * are the only member (by the project rule) and their API keys. The caller deletes the person.
 */
export async function prepareUserDeletion(ctx: ApiContext, userId: string): Promise<void> {
  const memberships = await all<{
    org: string;
    name: string;
    role: string;
    members: number;
    owners: number;
  }>(
    ctx.db,
    `SELECT m."organizationId" AS org, o.name, m.role,
       (SELECT count(*) FROM member x WHERE x."organizationId" = m."organizationId") AS members,
       (SELECT count(*) FROM member x WHERE x."organizationId" = m."organizationId"
          AND (',' || replace(x.role, ' ', '') || ',') LIKE '%,owner,%') AS owners
     FROM member m JOIN organization o ON o.id = m."organizationId"
     WHERE m."userId" = ?`,
    [userId],
  );
  const stranded = memberships.find(
    (m) =>
      m.role.split(",").some((r) => r.trim() === "owner") &&
      Number(m.owners) === 1 &&
      Number(m.members) > 1,
  );
  if (stranded)
    throw new ApiError(
      409,
      `This person is the only owner of ${stranded.name}, which has other members; transfer ownership first`,
      {},
      "only_owner",
    );
  for (const { org } of memberships.filter((m) => Number(m.members) === 1)) {
    const projects = await all<{ id: string }>(
      ctx.db,
      "SELECT id FROM products WHERE org_id = ? AND deleted_at IS NULL",
      [org],
    );
    for (const { id } of projects) await softDelete(ctx, id);
    // With no projects left to wipe, the organization goes now; otherwise after the last wipe.
    if ((await projectCount(ctx.db, org)) === 0) {
      await forgetOrganization(ctx.db, org);
      await ctx.db.execute("DELETE FROM organization WHERE id = ?", [org]);
    }
  }
  await ctx.db.execute('DELETE FROM apikey WHERE "referenceId" = ?', [userId]);
}

export function registerDeletion(): void {
  route("DELETE", "/api/products/:id", DELETE, async (_request, ctx, { id }) => {
    await deleteProject(ctx, id as string);
    return noContent();
  });

  route("GET", "/api/deleted-products", DELETE, async (_request, ctx) =>
    json(await listDeletedProjects(ctx, requireActor(ctx).orgId)),
  );

  route("POST", "/api/deleted-products/:key/restore", DELETE, async (_request, ctx, { key }) =>
    json(await restoreProject(ctx, requireActor(ctx).orgId, key as string)),
  );

  route("DELETE", "/api/admin/users/:key", "server-admin", async (request, ctx, { key }) => {
    const target = await one<{ id: string }>(ctx.db, 'SELECT id FROM "user" WHERE id = ?', [
      key as string,
    ]);
    if (!target) throw new ApiError(404, "User not found", {}, "not_found");
    if (target.id === requireActor(ctx).userId)
      throw bad("Delete your own account from your account settings");
    await prepareUserDeletion(ctx, target.id);
    await (await ctx.auth()).api.removeUser({
      body: { userId: target.id },
      headers: request.headers,
    });
    return noContent();
  });
}
