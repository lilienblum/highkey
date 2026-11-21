import { DisplayPreferencesProvider } from "@/components/display-preferences";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  redirect,
  Scripts,
  ScriptOnce,
  useRouterState,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Err } from "@/lib/error-codes";
import { getWorkspace } from "@/server/workspace";
import { activateOrganization, getViewer, type Viewer } from "@/server/viewer";
import {
  ACCOUNT_SETTINGS,
  isAccountScreen,
  isPublicPath,
  NEW_PROJECT,
  needsOrganization,
  needsProject,
} from "@/lib/auth-routes";
import { setPageOrganization } from "@/lib/api";
import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { sidebarScript } from "@/lib/preferences";
import styles from "../styles.css?url";
// Signing in or out, joining and switching organizations all load a new page, so in the browser
// the viewer from the first load stays right; asking again on every navigation (each filter
// change is one) would only add a round trip. The server asks on every request.
let browserViewer: Promise<Viewer | null> | undefined;
function currentViewer(): Promise<Viewer | null> {
  if (typeof window === "undefined") return getViewer();
  browserViewer ??= getViewer().catch((error) => {
    browserViewer = undefined;
    throw error;
  });
  return browserViewer;
}
function rememberViewer(viewer: Viewer): Viewer {
  if (typeof window !== "undefined") browserViewer = Promise.resolve(viewer);
  return viewer;
}
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Everyone signs in first; account screens (signing in, joining) are the only public pages.
  beforeLoad: async ({ location }) => {
    let viewer = await currentViewer();
    if (!viewer) {
      if (!isPublicPath(location.pathname))
        throw redirect({ href: `/sign-in?redirect=${encodeURIComponent(location.href)}` });
      return { viewer };
    }
    // An address under /<organization>/ makes that organization the session's, before the
    // workspace loads, so the API answers for it. A session whose organization is gone (deleted,
    // or the person left it) opens the person's first one instead.
    const first = location.pathname.split("/")[1];
    const addressed = viewer.organizations.find((org) => org.slug === first);
    const open = viewer.organizations.some((org) => org.id === viewer?.activeOrganizationId);
    const target = addressed ?? (open ? undefined : viewer.organizations[0]);
    if (target && target.id !== viewer.activeOrganizationId) {
      if (await activateOrganization({ data: target.id }))
        viewer = rememberViewer({ ...viewer, activeOrganizationId: target.id });
    }
    if (needsOrganization(location.pathname)) {
      // Without an organization, the person joins or creates one first.
      if (viewer.organizations.length === 0) throw redirect({ href: "/welcome" });
      // An organization requiring two-factor codes opens once the person has turned them on.
      const active = viewer.organizations.find((org) => org.id === viewer?.activeOrganizationId);
      if (active?.requireTwoFactor && !viewer.user.twoFactor)
        throw redirect({ href: ACCOUNT_SETTINGS });
    }
    return { viewer };
  },
  // The project catalog renders on the server and is reused by client navigation; mutations
  // refresh it in the shell. The root error screen retries with a fresh document request.
  // Account screens show no workspace, so they load none (the new-project page excepted);
  // account settings open without one.
  loader: async ({ location }) => {
    const path = location.pathname;
    if (isAccountScreen(path) && path !== NEW_PROJECT)
      return { initialProducts: [], serverNow: Date.now() };
    const workspace = await getWorkspace().catch((cause) => {
      console.error(`[${Err.WorkspaceLoadFailed}] Workspace request failed`, cause);
      throw new Error(Err.WorkspaceLoadFailed);
    });
    if ("errorCode" in workspace) throw new Error(workspace.errorCode);
    if ("blocked" in workspace) {
      if (path !== ACCOUNT_SETTINGS)
        throw redirect({
          href: workspace.blocked === "two_factor_required" ? ACCOUNT_SETTINGS : "/welcome",
        });
      return { initialProducts: [], serverNow: Date.now() };
    }
    // An organization without projects starts by creating one; its settings stay open.
    if (workspace.products.length === 0 && needsProject(path))
      throw redirect({ href: NEW_PROJECT });
    return { initialProducts: workspace.products, serverNow: Date.now() };
  },
  staleTime: Number.POSITIVE_INFINITY,
  shouldReload: false,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  errorComponent: WorkspaceError,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#1f1f28" },
      { title: "Highkey · Product analytics" },
      { name: "description", content: "A clear view of how your products are used." },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", href: "/favicon.svg?v=7", type: "image/svg+xml" },
    ],
  }),
  component: Root,
  shellComponent: Shell,
  notFoundComponent: () => (
    <div className="page-heading">
      <h1>Page not found</h1>
      <a href="/">Back to Overview</a>
    </div>
  ),
});
function Root() {
  const { initialProducts, serverNow } = Route.useLoaderData();
  // The router's client: one per page load, so results stay cached across navigation.
  const { queryClient } = Route.useRouteContext();
  const accountScreen = useRouterState({
    select: (state) => isAccountScreen(state.location.pathname),
  });
  const { viewer } = Route.useRouteContext();
  // Every API request from this page names its organization (see lib/api.ts).
  if (typeof window !== "undefined") setPageOrganization(viewer?.activeOrganizationId ?? null);
  return (
    <QueryClientProvider client={queryClient}>
      <DisplayPreferencesProvider>
        {accountScreen ? (
          <Outlet />
        ) : (
          <AppShell initialProducts={initialProducts} serverNow={serverNow} />
        )}
      </DisplayPreferencesProvider>
    </QueryClientProvider>
  );
}
function WorkspaceError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : null;
  const code = Object.values(Err).find((value) => value === message) ?? Err.UnexpectedAppError;
  return (
    <main className="workspace-error">
      <img src="/favicon.svg?v=7" width="40" height="40" alt="Highkey" />
      <h1>Something went wrong</h1>
      <p>
        If this keeps happening, email{" "}
        <a
          className="text-primary underline underline-offset-4"
          href={`mailto:support@usehighkey.com?subject=${encodeURIComponent(`Highkey error ${code}`)}`}
        >
          support@usehighkey.com
        </a>
        .
      </p>
      <small className="text-muted-foreground">
        Error code: <code>{code}</code>
      </small>
      <div className="flex flex-wrap justify-center gap-3">
        <Button nativeButton={false} role="link" render={<a href="" />}>
          Try again
        </Button>
        <Button variant="outline" nativeButton={false} role="link" render={<a href="/" />}>
          Go home
        </Button>
      </div>
    </main>
  );
}
function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <ScriptOnce>{sidebarScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
