export type WorkspaceView = "/" | "/explore" | "/logs" | "/settings";
const routes = {
  "/": "/projects/$projectSlug",
  "/explore": "/projects/$projectSlug/explore",
  "/logs": "/projects/$projectSlug/logs",
  "/settings": "/projects/$projectSlug/settings",
} as const;
export function workspaceTarget(view: WorkspaceView, projectSlug?: string) {
  return projectSlug ? { to: routes[view], params: { projectSlug } } : { to: view };
}
export function workspaceView(path: string): WorkspaceView {
  if (path.endsWith("/explore")) return "/explore";
  if (path.endsWith("/logs")) return "/logs";
  if (path.endsWith("/settings")) return "/settings";
  return "/";
}
