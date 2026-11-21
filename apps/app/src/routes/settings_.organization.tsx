import { createFileRoute } from "@tanstack/react-router";
import { OrganizationSettings } from "@/components/settings/organization";
import { managementSearch } from "@/lib/route-search";

export const Route = createFileRoute("/settings_/organization")({
  search: managementSearch,
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: OrganizationSettings,
});
