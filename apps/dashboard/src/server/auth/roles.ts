// What each organization role may do. A role covers every project of its organization (per-project
// access is later work). Better Auth's organization plugin enforces the `organization`, `member`
// and `invitation` statements itself; Highkey's routes check the rest with `can`.
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";

export const statement = {
  ...defaultStatements,
  project: ["create", "update", "delete", "move"],
  source: ["write"],
  key: ["write"],
  dashboard: ["write"],
  read: ["all"],
} as const;

export const ac = createAccessControl(statement);

const work = {
  source: ["write"],
  key: ["write"],
  dashboard: ["write"],
  read: ["all"],
} as const;

export const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    project: ["create", "update", "delete", "move"],
    ...work,
  }),
  admin: ac.newRole({
    ...adminAc.statements,
    project: ["create", "update", "delete", "move"],
    ...work,
  }),
  member: ac.newRole({ ...work }),
  viewer: ac.newRole({ read: ["all"] }),
};

export type Role = keyof typeof roles;
export type Permission = { [K in keyof typeof statement]?: (typeof statement)[K][number][] };

export function isRole(value: string): value is Role {
  return value in roles;
}

/** Whether `role` may do everything `permission` names. */
export function can(role: Role, permission: Permission): boolean {
  return roles[role].authorize(permission as never).success;
}

/** The most a credential acting for `role` may do: a viewer only reads. */
export function maxAccess(role: Role): "read" | "write" {
  return role === "viewer" ? "read" : "write";
}

/** Owners and admins oversee every key and agent connection in their organization. */
export function oversees(role: Role): boolean {
  return role === "owner" || role === "admin";
}
