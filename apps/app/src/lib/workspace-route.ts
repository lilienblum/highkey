import {
  useLocation,
  useMatches,
  useParams,
  useRouteContext,
  type MakeRouteMatch,
  type RegisteredRouter,
} from "@tanstack/react-router";
import { useCallback } from "react";
import type { WorkspaceSearch } from "./workspace-search";
import { profileUsesDates } from "./route-search";

export type WorkspaceView =
  | "/"
  | "/events"
  | "/logs"
  | "/settings"
  | "/dashboards"
  | "/revenue"
  | "/realtime"
  | "/sessions"
  | "/people"
  | "/ai";
const routes = {
  "/": "/$orgSlug/$projectSlug",
  "/events": "/$orgSlug/$projectSlug/events",
  "/logs": "/$orgSlug/$projectSlug/logs",
  "/revenue": "/$orgSlug/$projectSlug/revenue",
  "/realtime": "/$orgSlug/$projectSlug/realtime",
  "/sessions": "/$orgSlug/$projectSlug/sessions",
  "/people": "/$orgSlug/$projectSlug/people",
  "/ai": "/$orgSlug/$projectSlug/ai",
  "/settings": "/$orgSlug/$projectSlug/settings",
} as const;
export const projectRoute = "/$orgSlug/$projectSlug";
export const dashboardRoute = "/$orgSlug/$projectSlug/dashboards/$dashboardSlug";

export function hasReportDates(
  view: WorkspaceView,
  search: Parameters<typeof profileUsesDates>[0] = {},
) {
  if (view === "/people") return profileUsesDates(search);
  return view !== "/settings" && view !== "/logs" && view !== "/realtime";
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Resume this project's filters when leaving a page that doesn't show them. */
    reportScope?: {
      project: string;
      filters: Omit<WorkspaceSearch, "project" | "invalidWorkspace">;
    };
  }
}

/**
 * The canonical route for a workspace view: `/<organization>/<project>/…`. A dashboard needs its
 * slug; without one (or for another project, which has its own dashboards) the view falls back to
 * Overview. Without an organization or project the bare view (`/`, `/events`…) stands in.
 */
export function workspaceTarget(
  orgSlug: string | undefined,
  view: WorkspaceView,
  projectSlug?: string,
  dashboardSlug?: string,
) {
  if (view === "/dashboards") {
    if (orgSlug && projectSlug && dashboardSlug)
      return { to: dashboardRoute, params: { orgSlug, projectSlug, dashboardSlug } };
    return workspaceTarget(orgSlug, "/", projectSlug);
  }
  return orgSlug && projectSlug
    ? { to: routes[view], params: { orgSlug, projectSlug } }
    : {
        to:
          view === "/revenue" ||
          view === "/realtime" ||
          view === "/sessions" ||
          view === "/people" ||
          view === "/ai"
            ? "/"
            : view,
      };
}

/** The organization the page shows: the one in its URL, else the session's. */
export function useOrganizationSlug(): string | undefined {
  const { orgSlug } = useParams({ strict: false }) as { orgSlug?: string };
  const { viewer } = useRouteContext({ from: "__root__" });
  return (
    orgSlug ?? viewer?.organizations.find((org) => org.id === viewer.activeOrganizationId)?.slug
  );
}

type WorkspaceMatch = Pick<
  MakeRouteMatch<RegisteredRouter["routeTree"], string, false>,
  "pathname" | "params" | "search"
>;

/** Read path, params and validated search from the same committed page during navigation. */
export function useWorkspaceMatch() {
  return useMatches({
    select: (matches): WorkspaceMatch => {
      const { pathname, params, search } = matches[matches.length - 1]!;
      return { pathname, params, search };
    },
    structuralSharing: true,
  });
}

/** `workspaceTarget` for the organization the page shows. */
export function useWorkspaceTarget() {
  const orgSlug = useOrganizationSlug();
  const {
    pathname,
    params: { projectSlug: currentProject },
    search,
  } = useWorkspaceMatch();
  const { source, days, period, from, to, snapshot } = search;
  const reportScope = useLocation({ select: (location) => location.state.reportScope });
  const here = workspaceView(pathname);
  const usesDates = hasReportDates(here, search);
  return useCallback(
    (view: WorkspaceView, projectSlug?: string, dashboardSlug?: string) => {
      const target = workspaceTarget(orgSlug, view, projectSlug, dashboardSlug);
      const project = `${orgSlug}/${projectSlug}`;
      const parked = reportScope?.project === project ? reportScope.filters : undefined;
      if (!projectSlug || (currentProject !== projectSlug && !parked))
        return { ...target, search: undefined };
      const filters = usesDates
        ? { source, days, period, from, to, snapshot }
        : { ...parked, source: here === "/settings" ? (source ?? parked?.source) : source };
      return {
        ...target,
        // Date-less pages remember the report in this history entry, never in their address.
        state: hasReportDates(view) ? undefined : { reportScope: { project, filters } },
        search: view === "/settings" || usesDates ? undefined : filters,
      };
    },
    [
      orgSlug,
      currentProject,
      here,
      usesDates,
      reportScope,
      source,
      days,
      period,
      from,
      to,
      snapshot,
    ],
  );
}

/**
 * The view a path shows, matched by whole segments so a project slugged `dashboards`, `events`,
 * `logs` or `settings` still reads as its own Overview. Bare `/events`, `/logs` and `/settings`
 * are the browser-saved project's views; dashboards exist only under a project.
 */
/**
 * Pages about the organization or the account rather than a project: they stay where they are
 * instead of being sent to the saved project's address, and show under Settings.
 */
export function isOrganizationPage(path: string): boolean {
  return /^\/settings\/(organization|members|keys|agents|account)\/?$/.test(path);
}

export function workspaceView(path: string): WorkspaceView {
  if (/^\/[^/]+\/[^/]+\/realtime\/?$/.test(path)) return "/realtime";
  if (isOrganizationPage(path)) return "/settings";
  if (/^\/[^/]+\/[^/]+\/ai\/?$/.test(path)) return "/ai";
  if (/^\/[^/]+\/[^/]+\/revenue\/?$/.test(path)) return "/revenue";
  if (/^\/[^/]+\/[^/]+\/sessions\/?$/.test(path)) return "/sessions";
  if (/^\/[^/]+\/[^/]+\/people\/?$/.test(path)) return "/people";
  const view = /^(?:\/[^/]+\/[^/]+)?\/(events|logs|settings)\/?$/.exec(path)?.[1];
  if (view) return `/${view}` as WorkspaceView;
  if (/^\/[^/]+\/[^/]+\/dashboards\/[^/]+\/?$/.test(path)) return "/dashboards";
  return "/";
}
