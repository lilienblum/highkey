import { createFileRoute } from "@tanstack/react-router";
import { Realtime } from "@/components/realtime";
import { cohortSearch } from "@/lib/report-cohort";
export const Route = createFileRoute("/$orgSlug/$projectSlug/realtime")({
  component: Realtime,
  validateSearch: cohortSearch,
});
