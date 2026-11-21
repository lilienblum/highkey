import { createFileRoute } from "@tanstack/react-router";
import { Account } from "@/components/settings/account";
import { managementSearch } from "@/lib/route-search";

export const Route = createFileRoute("/settings_/account")({
  search: managementSearch,
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: Account,
});
