import { createFileRoute, Outlet } from "@tanstack/react-router";
import { managementSearch } from "@/lib/route-search";

export const Route = createFileRoute("/organizations/settings")({
  search: managementSearch,
  head: () => ({ meta: [{ title: "Organization settings · Highkey" }] }),
  component: Outlet,
});
