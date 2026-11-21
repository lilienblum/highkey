import { createFileRoute } from "@tanstack/react-router";
import { Realtime } from "@/components/realtime";
import { cohortSearch } from "@/lib/report-cohort";
import { workspaceSearch } from "@/lib/route-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug/realtime")({
  component: Realtime,
  ...workspaceSearch("source", cohortSearch),
});
