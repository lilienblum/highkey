import { createFileRoute } from "@tanstack/react-router";
import { Logs } from "@/components/logs";
import { validateLogsSearch } from "@/lib/logs";
import { workspaceSearch } from "@/lib/route-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug/logs")({
  ...workspaceSearch("source", validateLogsSearch),
  component: Logs,
});
