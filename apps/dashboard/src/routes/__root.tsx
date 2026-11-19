import { SkulletProvider } from "skullet/react";
import { DisplayPreferencesProvider } from "@/components/display-preferences";
import {
  createRootRouteWithContext,
  retainSearchParams,
  HeadContent,
  Outlet,
  redirect,
  Scripts,
  ScriptOnce,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { getWorkspace } from "@/server/workspace";
import { activateOrganization, getViewer, type Viewer } from "@/server/viewer";
import { ACCOUNT_SETTINGS, isAccountScreen, isPublicPath } from "@/lib/auth-routes";
import { setPageOrganization } from "@/lib/api";
import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { validateWorkspaceSearch } from "@/lib/workspace-search";
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
  validateSearch: validateWorkspaceSearch,
  search: {
    middlewares: [retainSearchParams(["source", "days", "period", "snapshot", "from", "to"])],
  },
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
    if (!isAccountScreen(location.pathname) && location.pathname !== ACCOUNT_SETTINGS) {
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
  // refresh it in the shell, and the workspace error screen retries it with router.invalidate().
  // Account screens show no workspace, so they load none; account settings open without one.
  loader: async ({ location }) => {
    if (isAccountScreen(location.pathname)) return { initialProducts: [], serverNow: Date.now() };
    const workspace = await getWorkspace();
    if ("blocked" in workspace) {
      if (location.pathname !== ACCOUNT_SETTINGS)
        throw redirect({
          href: workspace.blocked === "two_factor_required" ? ACCOUNT_SETTINGS : "/welcome",
        });
      return { initialProducts: [], serverNow: Date.now() };
    }
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
        <SkulletProvider
          theme={{
            light: { base: "var(--skeleton-base)", highlight: "var(--skeleton-highlight)" },
            dark: { base: "var(--skeleton-base)", highlight: "var(--skeleton-highlight)" },
            radius: "3px",
            animation: "shimmer",
            speed: "slow",
          }}
          reveal={{ order: "together", duration: 120, hold: 150 }}
        >
          {accountScreen ? (
            <Outlet />
          ) : (
            <AppShell initialProducts={initialProducts} serverNow={serverNow} />
          )}
        </SkulletProvider>
      </DisplayPreferencesProvider>
    </QueryClientProvider>
  );
}
function WorkspaceError() {
  const router = useRouter();
  return (
    <main className="workspace-error">
      <img src="/favicon.svg?v=7" width="40" height="40" alt="Highkey" />
      <h1>Couldn’t open your workspace</h1>
      <p>Check that the API is running, then try again. Your projects and data haven’t changed.</p>
      <Button onClick={() => void router.invalidate()}>Try again</Button>
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
        <template
          data-design-contract="kanagawa-wave"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static build-time design provenance; no dynamic or user content.
          dangerouslySetInnerHTML={{
            __html: `<!--
THESIS: Highkey is a compact measurement tool with a graphic identity; evidence remains the main content.
OWN-WORLD: One Kanagawa Wave palette: sumi-ink surfaces, warm Fuji text, Surimi Orange actions, Carp Yellow measurements, violet/aqua categories, and green outcomes. Geist, softly squared controls, inset fields, single-frame segments, and the upright three-bar mark.
STORY: Choose project, source and dates; follow an event trend; inspect the evidence; manage collection. Identity stays optional.
FIRST VIEWPORT: Keep the project/source rail and report controls. Overview uses six square analytical widgets; Events keeps its query, chart, breakdown and event stream; Logs keeps its query bar and volume above a virtualized log stream.
FORM: User-selected Kanagawa Wave palette from the official rebelot/kanagawa.nvim source. One static dark theme with no selector or preference. Rebuilt shadcn Base UI defaults: semantic state tokens, 6px controls, 12px cards, warm selection, and soft overlay shadows. Preserve the approved layouts and behavior; this is an existing-world component redesign, not a new surface concept.
-->`,
          }}
        />
        {children}
        <Scripts />
      </body>
    </html>
  );
}
