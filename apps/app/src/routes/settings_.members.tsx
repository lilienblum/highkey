import { createFileRoute } from "@tanstack/react-router";
import { Members } from "@/components/settings/members";
import { managementSearch } from "@/lib/route-search";

export const Route = createFileRoute("/settings_/members")({
  search: managementSearch,
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: Members,
});
