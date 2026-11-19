import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Logout03Icon, Tick02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { useRouteContext } from "@tanstack/react-router";
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
import { authPost } from "@/lib/auth-client";
import { useOrganizationSlug } from "@/lib/workspace-route";

const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/** A short slug from a new organization's name; the server adds a suffix when it is taken. */
function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .split(/[^a-z0-9]/)
      .filter(Boolean)
      .join("-")
      .slice(0, 48)
      .replace(/-+$/, "") || "organization"
  );
}

/**
 * The organization above the project picker, and the account: which organization the workspace
 * shows (in place of the picker's label, so it costs no height), the others
 * the person belongs to, a new one, and signing out. Switching loads the other organization's
 * address afresh, so every page, cache and live stream belongs to it.
 */
export function OrganizationMenu() {
  const { viewer } = useRouteContext({ from: "__root__" });
  const current = useOrganizationSlug();
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!viewer) return null;
  const organization = viewer.organizations.find((org) => org.slug === current);
  const signOut = async () => {
    await authPost("/sign-out");
    window.location.assign("/sign-in");
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              ref={trigger}
              type="button"
              className="workspace-section-label organization-trigger"
              aria-label={`Organization: ${organization?.name ?? "none"}. Switch organization`}
            />
          }
        >
          <span className="organization-name">{organization?.name ?? "No organization"}</span>
          <HugeiconsIcon
            icon={UnfoldMoreIcon}
            strokeWidth={2}
            aria-hidden="true"
            className="organization-chevron"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="organization-person">
              Signed in as {viewer.user.email}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {viewer.organizations.map((org) => (
              <DropdownMenuItem
                key={org.id}
                render={<a href={`/${org.slug}`} />}
                aria-current={org.slug === current ? "true" : undefined}
              >
                <span className="organization-item">
                  <span>{org.name}</span>
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
        description="You’ll own it. Invite people and create projects in it from Settings."
        initialName=""
        submitLabel="Create"
        failure="Could not create the organization."
        finalFocus={trigger}
        onSubmit={async (name) => {
          // Its address comes from the name; a taken or reserved one gets a number.
          const base = slugFor(name);
          for (let attempt = 1; attempt <= 5; attempt++) {
            const slug = attempt === 1 ? base : `${base}-${attempt}`;
            const created = await authPost<{ slug?: string }>("/organization/create", {
              name,
              slug,
            });
            if (created.ok && created.data?.slug) {
              window.location.assign(`/${created.data.slug}`);
              return new Promise<void>(() => {});
            }
            if (created.status !== 400) throw new Error(created.error ?? undefined);
          }
          throw new Error("That name’s address is taken. Try another name.");
        }}
      />
    </>
  );
}
