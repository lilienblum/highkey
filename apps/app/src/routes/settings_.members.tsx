import { createFileRoute } from "@tanstack/react-router";
import { Members } from "@/components/settings/members";

export const Route = createFileRoute("/settings_/members")({
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: Members,
});
