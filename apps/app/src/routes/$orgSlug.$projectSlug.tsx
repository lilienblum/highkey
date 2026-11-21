import { createFileRoute, Outlet } from "@tanstack/react-router";
import { projectSearch } from "@/lib/route-search";
export const Route = createFileRoute("/$orgSlug/$projectSlug")({
  search: projectSearch,
  component: Outlet,
});
