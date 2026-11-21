import { createFileRoute } from "@tanstack/react-router";
import { GroupDirectory } from "@/components/group-directory";
import { groupSearch } from "@/lib/group-search";
import { workspaceSearch } from "@/lib/route-search";

export const Route = createFileRoute("/$orgSlug/$projectSlug/groups")({
  ...workspaceSearch("report", groupSearch),
  head: () => ({ meta: [{ title: "Groups · Highkey" }] }),
  component: GroupDirectory,
});
