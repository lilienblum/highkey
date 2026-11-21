import { createFileRoute } from "@tanstack/react-router";
import { Agents } from "@/components/settings/agents";

export const Route = createFileRoute("/organizations/settings/agents")({ component: Agents });
