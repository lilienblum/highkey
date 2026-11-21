import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Logout03Icon,
  Tick02Icon,
  UnfoldMoreIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NameDialog } from "@/components/name-dialog";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { authPost } from "@/lib/auth-client";
import { createOrganization } from "@/lib/organizations";
import { useOrganizationSlug, useWorkspaceTarget } from "@/lib/workspace-route";
import { ACCOUNT_SETTINGS, ORGANIZATION_SETTINGS } from "@/lib/auth-routes";

const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/**
 * Switching organizations loads a fresh document so every page, cache and live stream belongs to it.
 */
export function OrganizationMenu({ projectSlug }: { projectSlug?: string }) {
  const { viewer } = useRouteContext({ from: "__root__" });
  const current = useOrganizationSlug();
  const target = useWorkspaceTarget();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!viewer) return null;
  const organization = viewer.organizations.find((org) => org.slug === current);
  const collapsed = state === "collapsed" && !isMobile;
  const identity = viewer.user.name || viewer.user.email;
  const orgName = organization?.name ?? "No organization";
  const reportState = target("/settings", projectSlug).state ?? true;
  const signOut = async () => {
    await authPost("/sign-out");
    window.location.assign("/sign-in");
  };
  return (
    <>
      <DropdownMenu>
        <SidebarMenuButton
          className="organization-trigger"
          size="lg"
          tooltip="Account and organization"
          aria-label={`Account and organization: ${identity}, ${orgName}`}
          render={<DropdownMenuTrigger ref={trigger} />}
        >
          <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} aria-hidden="true" />
          <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">{identity}</span>
            <span className="truncate text-xs text-muted-foreground">{orgName}</span>
          </span>
          <HugeiconsIcon
            icon={UnfoldMoreIcon}
            strokeWidth={2}
            aria-hidden="true"
            className="text-muted-foreground group-data-[collapsible=icon]:hidden"
          />
        </SidebarMenuButton>
        <DropdownMenuContent
          side={collapsed ? "right" : "top"}
          align={collapsed ? "end" : "start"}
          sideOffset={8}
          className="w-64 max-w-[calc(100vw-1rem)]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal [overflow-wrap:anywhere]">
              Signed in as {viewer.user.email}
            </DropdownMenuLabel>
            <DropdownMenuItem
              render={
                <Link
                  to={ACCOUNT_SETTINGS}
                  state={reportState}
                  onClick={() => setOpenMobile(false)}
                />
              }
            >
              Account settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {organization && (
            <>
              <DropdownMenuItem
                render={
                  <Link
                    to={ORGANIZATION_SETTINGS}
                    state={reportState}
                    onClick={() => setOpenMobile(false)}
                  />
                }
              >
                Organization settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {viewer.organizations.map((org) => (
              <DropdownMenuItem
                key={org.id}
                render={<a href={`/${org.slug}`} />}
                aria-current={org.slug === current ? "true" : undefined}
              >
                <span className="organization-item">
                  <span className="[overflow-wrap:anywhere]">{org.name}</span>
                  <span className="organization-role">{ROLE[org.role] ?? org.role}</span>
                </span>
                {org.slug === current ? (
                  <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-label="Current" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
            Create organization
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void signOut()}>
            <HugeiconsIcon icon={Logout03Icon} strokeWidth={2} aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="Create organization"
        description="You’ll own it. Invite people from Organization settings."
        initialName=""
        submitLabel="Create"
        failure="Could not create the organization."
        finalFocus={trigger}
        onSubmit={async (name) => {
          window.location.assign(`/${await createOrganization(name)}`);
          return new Promise<void>(() => {});
        }}
      />
    </>
  );
}
