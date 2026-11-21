import { createFileRoute } from "@tanstack/react-router";
import { Overview } from "@/components/overview";
import { validateOverviewSearch } from "@/lib/workspace-search";
import { workspaceSearch } from "@/lib/route-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug/")({
  ...workspaceSearch("report", validateOverviewSearch),
  component: Overview,
});
