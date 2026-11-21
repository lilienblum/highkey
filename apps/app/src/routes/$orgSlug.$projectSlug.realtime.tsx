import { createFileRoute } from "@tanstack/react-router";
import { Realtime } from "@/components/realtime";
export const Route = createFileRoute("/$orgSlug/$projectSlug/realtime")({ component: Realtime });
