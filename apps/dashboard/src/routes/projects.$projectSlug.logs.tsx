import { createFileRoute } from "@tanstack/react-router";
import { Logs } from "@/components/logs";
import { validateLogsSearch } from "@/lib/logs";
export const Route = createFileRoute("/projects/$projectSlug/logs")({
  validateSearch: validateLogsSearch,
  component: Logs,
});
