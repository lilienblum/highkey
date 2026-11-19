import { createFileRoute } from "@tanstack/react-router";
import { Account } from "@/components/settings/account";

export const Route = createFileRoute("/settings_/account")({
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: Account,
});
