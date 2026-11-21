import { createFileRoute } from "@tanstack/react-router";
import { Revenue } from "@/components/revenue";

export const Route = createFileRoute("/$orgSlug/$projectSlug/revenue")({
  validateSearch: (s: Record<string, unknown>) => ({
    group:
      s.group === "session" || s.group === "profile" || s.group === "page" ? s.group : undefined,
    page:
      typeof s.page === "number" && Number.isInteger(s.page) && s.page > 1 && s.page <= 10000
        ? s.page
        : undefined,
  }),
  component: Revenue,
});
