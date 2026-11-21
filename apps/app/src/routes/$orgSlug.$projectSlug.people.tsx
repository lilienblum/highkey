import { createFileRoute, redirect } from "@tanstack/react-router";
import { groupSearch } from "@/lib/group-search";
import { validateWorkspaceSearch } from "@/lib/workspace-search";
import { workspaceSearch } from "@/lib/route-search";
import { People } from "@/components/people";
export const Route = createFileRoute("/$orgSlug/$projectSlug/people")({
  ...workspaceSearch(
    "profiles",
    (
      s: Record<string, unknown>,
    ): {
      kind?: string;
      audience?: string;
      find?: string;
      person?: string;
      groupType?: string;
      groupId?: string;
      cohort?: string;
      tab?: string;
      page?: number;
    } => ({
      audience:
        s.audience === undefined
          ? undefined
          : typeof s.audience === "string" && s.audience.length <= 8192
            ? s.audience
            : "invalid",
      kind:
        s.kind === "anonymous" || s.kind === "power" || s.kind === "groups" ? s.kind : undefined,
      ...groupSearch(s),
      person:
        typeof s.person === "string" && s.person && new TextEncoder().encode(s.person).length <= 128
          ? s.person
          : undefined,
      tab: s.tab === "sessions" ? s.tab : undefined,
    }),
  ),
  beforeLoad: ({ params, search }) => {
    if (search.kind === "groups")
      throw redirect({
        to: "/$orgSlug/$projectSlug/groups",
        params,
        search: { ...validateWorkspaceSearch(search), ...groupSearch(search) },
        replace: true,
      });
  },
  head: () => ({ meta: [{ title: "Profiles · Highkey" }] }),
  component: People,
});
