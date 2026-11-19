import { Link, useLocation, useRouteContext } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/**
 * The parts of Settings: the open project's, then the organization's (its details, people,
 * API keys and agents), then the person's own account, and the server admin's page for them.
 */
export function SettingsNav() {
  const path = useLocation({ select: (location) => location.pathname });
  const { viewer } = useRouteContext({ from: "__root__" });
  const items: [string, string, boolean][] = [
    ["/settings", "Project", /^(\/[^/]+\/[^/]+)?\/settings\/?$/.test(path)],
    ["/settings/organization", "Organization", path.startsWith("/settings/organization")],
    ["/settings/members", "Members", path.startsWith("/settings/members")],
    ["/settings/keys", "API keys", path.startsWith("/settings/keys")],
    ["/settings/agents", "Agents", path.startsWith("/settings/agents")],
    ["/settings/account", "Account", path.startsWith("/settings/account")],
  ];
  if (viewer?.user.serverAdmin) items.push(["/admin", "Server", path.startsWith("/admin")]);
  return (
    <nav className="settings-nav" aria-label="Settings">
      {items.map(([to, label, active]) => (
        <Link
          key={to}
          to={to}
          className={cn("settings-nav-link", active && "is-active")}
          aria-current={active ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
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
