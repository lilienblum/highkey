import { createFileRoute } from "@tanstack/react-router";
import { AIReport } from "@/components/ai-report";
export const Route = createFileRoute("/$orgSlug/$projectSlug/ai")({
  validateSearch: (
    s: Record<string, unknown>,
  ): { aiGroup?: string; trace?: string; page?: number } => ({
    aiGroup: s.aiGroup === "profile" || s.aiGroup === "feature" ? s.aiGroup : undefined,
    trace:
      typeof s.trace === "string" && s.trace && new TextEncoder().encode(s.trace).length <= 128
        ? s.trace
        : undefined,
    page:
      typeof s.page === "number" && Number.isInteger(s.page) && s.page > 1 && s.page <= 10000
        ? s.page
        : undefined,
  }),
  component: AIReport,
});
