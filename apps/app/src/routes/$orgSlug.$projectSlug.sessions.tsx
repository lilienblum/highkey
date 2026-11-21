import { createFileRoute } from "@tanstack/react-router";
import { Sessions } from "@/components/sessions";
import { sessionsSearch } from "@/lib/sessions";
import { workspaceSearch } from "@/lib/route-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug/sessions")({
  ...workspaceSearch("report", sessionsSearch),
  component: Sessions,
});
