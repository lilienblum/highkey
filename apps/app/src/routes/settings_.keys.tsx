import { createFileRoute } from "@tanstack/react-router";
import { ApiKeys } from "@/components/settings/api-keys";
import { managementSearch } from "@/lib/route-search";

export const Route = createFileRoute("/settings_/keys")({
  search: managementSearch,
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: ApiKeys,
});
