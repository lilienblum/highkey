import { createFileRoute } from "@tanstack/react-router";
import { Revenue } from "@/components/revenue";
import { cohortSearch } from "@/lib/report-cohort";
import { workspaceSearch } from "@/lib/route-search";

export const Route = createFileRoute("/$orgSlug/$projectSlug/revenue")({
  ...workspaceSearch("report", (s: Record<string, unknown>) => ({
    ...cohortSearch(s),
    group:
      s.group === "session" || s.group === "profile" || s.group === "page" ? s.group : undefined,
    page:
      typeof s.page === "number" && Number.isInteger(s.page) && s.page > 1 && s.page <= 10000
        ? s.page
        : undefined,
  })),
  component: Revenue,
});
