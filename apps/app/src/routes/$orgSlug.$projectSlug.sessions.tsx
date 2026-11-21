import { createFileRoute } from "@tanstack/react-router";
import { Sessions } from "@/components/sessions";
import { sessionsSearch } from "@/lib/sessions";
export const Route = createFileRoute("/$orgSlug/$projectSlug/sessions")({
  validateSearch: sessionsSearch,
  component: Sessions,
});
