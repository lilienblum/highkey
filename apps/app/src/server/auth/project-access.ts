import type { Db } from "../db/db";
import { all, one } from "../db/db";
import { products, resolveProduct } from "../db/products";
import { ApiError, projectMissing } from "../api/errors";
import type { ApiContext } from "../api/context";
import type { Actor } from "./actor";
import { oversees, type Role } from "./roles";

export type ProjectGrants = Record<string, "read" | "write">;
export async function grants(
  db: Db,
  org: string,
  user: string,
  role: Role,
): Promise<ProjectGrants | undefined> {
  if (oversees(role)) return undefined;
  const rows = await all<{ project_id: string | null; access: "read" | "write" | null }>(
    db,
    `SELECT g.project_id,g.access FROM member m JOIN restricted_members r ON r.member_id=m.id LEFT JOIN member_projects g ON g.member_id=m.id WHERE m.organizationId=? AND m.userId=?`,
    [org, user],
  );
  if (!rows.length) return undefined;
  return Object.fromEntries(
    rows.flatMap((r) => (r.project_id && r.access ? [[r.project_id, r.access]] : [])),
  );
}
export function projectAccess(actor: Actor, id: string): "read" | "write" {
  if (
    (actor.tokenProject && actor.tokenProject !== id) ||
    (actor.projects && !Object.hasOwn(actor.projects, id))
  )
    throw projectMissing();
  return actor.access === "read" || actor.projects?.[id] === "read" ? "read" : "write";
}
export async function visibleProjects(ctx: ApiContext, actor: Actor) {
  const allowed = actor.tokenProject
    ? [actor.tokenProject].filter((id) => !actor.projects || Object.hasOwn(actor.projects, id))
    : actor.projects
      ? Object.keys(actor.projects)
      : undefined;
  return products(ctx.db, actor.orgId, allowed);
}
export const forbiddenScope = () =>
  new ApiError(403, "This project access does not allow that action", {}, "forbidden");
export async function scopedProject(ctx: ApiContext, actor: Actor, key: string) {
  const p = await resolveProduct(ctx.db, key, actor.orgId);
  return { id: p.id, access: projectAccess(actor, p.id) };
}
export async function memberForScope(db: Db, actor: Actor, member: string) {
  if (actor.via !== "session" || !oversees(actor.role)) throw forbiddenScope();
  const target = await one<{ id: string; role: string }>(
    db,
    "SELECT id,role FROM member WHERE id=? AND organizationId=?",
    [member, actor.orgId],
  );
  if (!target) throw new ApiError(404, "Member not found");
  if (target.role.split(",").some((r) => r === "admin" || r === "owner"))
    throw new ApiError(400, "Owners and admins manage every project");
  return target;
}
