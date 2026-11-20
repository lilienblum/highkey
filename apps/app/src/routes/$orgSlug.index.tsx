import { createFileRoute } from "@tanstack/react-router";
import { Overview } from "@/components/overview";
import { validateOverviewSearch } from "@/lib/workspace-search";

// An organization's own address opens its Overview, on the project last chosen there.
export const Route = createFileRoute("/$orgSlug/")({
  validateSearch: validateOverviewSearch,
  component: Overview,
});
