import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "@/components/settings";
import { workspaceSearch } from "@/lib/route-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug/settings")({
  ...workspaceSearch("settings"),
  component: Settings,
});
