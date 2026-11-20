import { createFileRoute } from "@tanstack/react-router";
import { Explore } from "@/components/explore";
import { validateExploreSearch } from "@/lib/explore-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug/events")({
  validateSearch: validateExploreSearch,
  component: Explore,
});
