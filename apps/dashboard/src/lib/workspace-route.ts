export type WorkspaceView = "/" | "/events" | "/logs" | "/settings" | "/dashboards";
const routes = {
  "/": "/projects/$projectSlug",
  "/events": "/projects/$projectSlug/events",
  "/logs": "/projects/$projectSlug/logs",
  "/settings": "/projects/$projectSlug/settings",
} as const;
export const dashboardRoute = "/projects/$projectSlug/dashboards/$dashboardSlug";
/**
 * The canonical route for a workspace view. A dashboard needs its slug; without one (or for
 * another project, which has its own dashboards) the view falls back to Overview.
 */
export function workspaceTarget(view: WorkspaceView, projectSlug?: string, dashboardSlug?: string) {
  if (view === "/dashboards") {
    if (projectSlug && dashboardSlug)
      return { to: dashboardRoute, params: { projectSlug, dashboardSlug } };
    return workspaceTarget("/", projectSlug);
  }
  return projectSlug ? { to: routes[view], params: { projectSlug } } : { to: view };
}
/**
 * The view a path shows, matched by whole segments so a project slugged `dashboards`, `events`,
 * `logs` or `settings` still reads as its own Overview. Bare `/events`, `/logs` and `/settings`
 * are the browser-saved project's views; dashboards exist only under a project.
 */
export function workspaceView(path: string): WorkspaceView {
  const view = /^(?:\/projects\/[^/]+)?\/(events|logs|settings)\/?$/.exec(path)?.[1];
  if (view) return `/${view}` as WorkspaceView;
  if (/^\/projects\/[^/]+\/dashboards\/[^/]+\/?$/.test(path)) return "/dashboards";
  return "/";
}
