import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { legacySettings } from "@/lib/auth-routes";

export const Route = createFileRoute("/settings_/$section")({
  beforeLoad: ({ params }) => {
    const path = `/settings/${params.section}`;
    if (!Object.hasOwn(legacySettings, path)) throw notFound();
    throw redirect({ to: legacySettings[path as keyof typeof legacySettings], replace: true });
  },
});
