import { createFileRoute } from "@tanstack/react-router";
import { People } from "@/components/people";
export const Route = createFileRoute("/$orgSlug/$projectSlug/people")({
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    kind?: string;
    find?: string;
    person?: string;
    groupType?: string;
    groupId?: string;
    tab?: string;
    page?: number;
  } => ({
    kind: s.kind === "anonymous" || s.kind === "power" || s.kind === "groups" ? s.kind : undefined,
    find: typeof s.find === "string" && s.find.length <= 256 ? s.find : undefined,
    person:
      typeof s.person === "string" && s.person && new TextEncoder().encode(s.person).length <= 128
        ? s.person
        : undefined,
    groupType:
      typeof s.groupType === "string" && /^[a-zA-Z0-9_./-]{1,64}$/.test(s.groupType)
        ? s.groupType
        : undefined,
    groupId: typeof s.groupId === "string" && s.groupId.length <= 128 ? s.groupId : undefined,
    tab: s.tab === "sessions" ? s.tab : undefined,
    page:
      typeof s.page === "number" && Number.isInteger(s.page) && s.page > 1 && s.page <= 10000
        ? s.page
        : undefined,
  }),
  component: People,
});
