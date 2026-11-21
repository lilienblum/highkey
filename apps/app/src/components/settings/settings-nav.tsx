import { Link, useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageHeader } from "../app-shell";

const sections = [
  ["/organizations/settings", "General"],
  ["/organizations/settings/members", "Members"],
  ["/organizations/settings/keys", "API keys"],
  ["/organizations/settings/agents", "Agents"],
] as const;

export function OrganizationSettingsHeader({ children }: { children?: ReactNode }) {
  const { viewer } = useRouteContext({ from: "__root__" });
  const org = viewer?.organizations.find((o) => o.id === viewer.activeOrganizationId);
  return (
    <>
      <PageHeader title="Organization settings" description={org?.name ?? ""}>
        {children}
      </PageHeader>
      <nav className="settings-nav" aria-label="Organization settings">
        {sections.map(([to, label]) => (
          <Link
            key={to}
            to={to}
            state={true}
            className="settings-nav-link"
            activeOptions={{ exact: true, includeSearch: false }}
            activeProps={{ className: "is-active" }}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/** The role names people see. */
export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/** The viewer's role in their open organization. */
export function useOrganizationRole(): string | null {
  const { viewer } = useRouteContext({ from: "__root__" });
  return viewer?.organizations.find((org) => org.id === viewer.activeOrganizationId)?.role ?? null;
}

/** Owners and admins manage people, keys and connections of everyone in the organization. */
export function oversees(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The organization this page shows, which every organization call names explicitly. */
export function useOrganizationId(): string {
  const { viewer } = useRouteContext({ from: "__root__" });
  return viewer?.activeOrganizationId ?? "";
}
