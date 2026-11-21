import { retainSearchParams, stripSearchParams } from "@tanstack/react-router";
import { validateWorkspaceSearch, type WorkspaceSearch } from "./workspace-search";

const dates = ["days", "period", "snapshot", "from", "to"] as const;
const keepReport = retainSearchParams<WorkspaceSearch>(["source", ...dates]);
const keepSource = retainSearchParams<WorkspaceSearch>(["source"]);
const dropDates = stripSearchParams<WorkspaceSearch>([...dates]);

/** Only project paths have deterministic defaults. A bare entry can still override browser preferences. */
export const projectSearch = {
  middlewares: [stripSearchParams<WorkspaceSearch>({ source: "all", days: 7 })],
};
export const managementSearch = {
  middlewares: [
    stripSearchParams<WorkspaceSearch>(["project", "source", ...dates, "invalidWorkspace"]),
  ],
};

/** A destination inherits only the filters it uses. Settings accepts an explicit install-guide source. */
export function workspaceSearch<T extends object = {}>(
  scope: "report" | "source" | "settings",
  page?: (raw: Record<string, unknown>) => T,
) {
  return {
    search: {
      middlewares:
        scope === "report"
          ? [keepReport]
          : scope === "source"
            ? [keepSource, dropDates]
            : [dropDates],
    },
    validateSearch: (raw: Record<string, unknown>) => ({
      ...validateWorkspaceSearch(
        scope === "report"
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
