import { createFileRoute } from "@tanstack/react-router";
import { ApiKeys } from "@/components/settings/api-keys";

export const Route = createFileRoute("/settings_/keys")({
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: ApiKeys,
});
