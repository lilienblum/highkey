import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettings } from "@/components/settings/organization";

export const Route = createFileRoute("/organizations/settings/")({
  component: OrganizationSettings,
});
