import { createFileRoute } from "@tanstack/react-router";
import { Agents } from "@/components/settings/agents";
import { managementSearch } from "@/lib/route-search";

export const Route = createFileRoute("/settings_/agents")({
  search: managementSearch,
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: Agents,
});
