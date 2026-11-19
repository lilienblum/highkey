import { createFileRoute } from "@tanstack/react-router";
import { Agents } from "@/components/settings/agents";

export const Route = createFileRoute("/settings_/agents")({
  head: () => ({ meta: [{ title: "Settings · Highkey" }] }),
  component: Agents,
});
