import { useParams, useRouteContext } from "@tanstack/react-router";
import { useCallback } from "react";

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

/** `workspaceTarget` for the organization the page shows. */
export function useWorkspaceTarget() {
  const orgSlug = useOrganizationSlug();
  return useCallback(
    (view: WorkspaceView, projectSlug?: string, dashboardSlug?: string) =>
      workspaceTarget(orgSlug, view, projectSlug, dashboardSlug),
    [orgSlug],
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
  return /^\/(settings\/(organization|members|keys|agents|account)|admin)\/?$/.test(path);
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
