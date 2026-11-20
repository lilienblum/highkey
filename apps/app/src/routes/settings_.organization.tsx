import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettings } from "@/components/settings/organization";

export const Route = createFileRoute("/settings_/organization")({
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: OrganizationSettings,
});
