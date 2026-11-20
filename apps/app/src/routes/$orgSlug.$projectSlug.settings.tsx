import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "@/components/settings";
export const Route = createFileRoute("/$orgSlug/$projectSlug/settings")({ component: Settings });
