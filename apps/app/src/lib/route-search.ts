import {
  retainSearchParams,
  stripSearchParams,
  type SearchMiddleware,
} from "@tanstack/react-router";
import { validateWorkspaceSearch, type WorkspaceSearch } from "./workspace-search";

const dates = ["days", "period", "snapshot", "from", "to"] as const;
const keepReport = retainSearchParams<WorkspaceSearch>([...dates]);
const dropDates = stripSearchParams<WorkspaceSearch>([...dates]);

type ProfileContext = { person?: string; audience?: string; kind?: string };
export function profileUsesDates(s: ProfileContext) {
  return Boolean(s.person || s.audience || s.kind === "groups");
}
const directoryDates: SearchMiddleware<WorkspaceSearch & ProfileContext> = ({ search, next }) => {
  const result = next(search);
  if (profileUsesDates(result)) return result;
  const clean = { ...result };
  for (const key of dates) delete clean[key];
  return clean;
};

/** Only project paths have deterministic defaults. A bare entry can still override browser preferences. */
export const projectSearch = {
  middlewares: [stripSearchParams<WorkspaceSearch>({ days: 7 })],
};
export const managementSearch = {
  middlewares: [
    stripSearchParams<WorkspaceSearch>(["project", "source", ...dates, "invalidWorkspace"]),
  ],
};

/** A destination inherits only the filters it uses. Settings accepts an explicit install-guide source. */
export function workspaceSearch<T extends object = {}>(
  scope: "report" | "source" | "settings" | "profiles",
  page?: (raw: Record<string, unknown>) => T,
) {
  return {
    search: {
      middlewares:
        scope === "profiles"
          ? [directoryDates, keepReport]
          : scope === "report"
            ? [keepReport]
            : [dropDates],
    },
    validateSearch: (raw: Record<string, unknown>) => ({
      ...validateWorkspaceSearch(
        scope === "report" || (scope === "profiles" && profileUsesDates(raw))
          ? raw
          : {
              project: raw.project,
              source: raw.source,
              invalidWorkspace: raw.invalidWorkspace,
            },
      ),
      ...(page?.(raw) as Partial<T>),
    }),
  };
}
