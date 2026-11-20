import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

// Everything under /<organization>/ belongs to one organization the person is a member of; the
// root route has already made it the session's organization. Another organization's address is
// simply not found.
export const Route = createFileRoute("/$orgSlug")({
  beforeLoad: ({ context, params }) => {
    const organization = context.viewer?.organizations.find((org) => org.slug === params.orgSlug);
    if (!organization) throw notFound();
    return { organization };
  },
  component: Outlet,
});
