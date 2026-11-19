import { createFileRoute, redirect } from "@tanstack/react-router";
import { projectOrganizations } from "@/server/viewer";

// Project addresses gained their organization (`/projects/orbit/…` → `/acme/orbit/…`). An old
// link still opens when one of the person's organizations has a project by that slug.
export const Route = createFileRoute("/projects/$")({
  beforeLoad: async ({ params, location, context }) => {
    const [slug, ...rest] = (params._splat ?? "").split("/");
    if (!slug) throw redirect({ href: "/", replace: true });
    const organizations = await projectOrganizations({ data: slug });
    const active = context.viewer?.organizations.find(
      (org) => org.id === context.viewer?.activeOrganizationId,
    )?.slug;
    // One match, or the open organization among several; otherwise the workspace says the
    // project is unavailable (the legacy `?project=` entry), as for any unknown project.
    const organization =
      organizations.length === 1
        ? organizations[0]
        : active && organizations.includes(active)
          ? active
          : undefined;
    if (!organization)
      throw redirect({ href: `/?project=${encodeURIComponent(slug)}`, replace: true });
    const path = [organization, slug, ...rest].filter(Boolean).join("/");
    throw redirect({ href: `/${path}${location.searchStr}`, replace: true });
  },
});
