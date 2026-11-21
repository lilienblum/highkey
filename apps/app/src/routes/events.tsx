import { createFileRoute } from "@tanstack/react-router";
import { Explore } from "@/components/explore";
import { validateExploreSearch } from "@/lib/explore-search";
import { workspaceSearch } from "@/lib/route-search";
export const Route = createFileRoute("/events")({
  ...workspaceSearch("report", validateExploreSearch),
  component: Explore,
});
