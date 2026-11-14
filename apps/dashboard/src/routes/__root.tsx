import { SkulletProvider } from "skullet/react";
import { DisplayPreferencesProvider } from "@/components/display-preferences";
import {
  createRootRoute,
  retainSearchParams,
  HeadContent,
  Scripts,
  ScriptOnce,
  useRouter,
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { getWorkspace } from "@/server/workspace";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { validateWorkspaceSearch } from "@/lib/workspace-search";
import { sidebarScript } from "@/lib/preferences";
import styles from "../styles.css?url";
export const Route = createRootRoute({
  validateSearch: validateWorkspaceSearch,
  search: {
    middlewares: [retainSearchParams(["source", "days", "period", "snapshot", "from", "to"])],
  },
  // The project catalog renders on the server and is reused by client navigation; mutations
  // refresh it in the shell, and the workspace error screen retries it with router.invalidate().
  loader: async () => ({ initialProducts: await getWorkspace(), serverNow: Date.now() }),
  staleTime: Number.POSITIVE_INFINITY,
  shouldReload: false,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  errorComponent: WorkspaceError,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#1f1f28" },
      { title: "Piko · Product analytics" },
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
  // One client per page load: analytics and logs results stay cached across navigation.
  const [queryClient] = useState(() => new QueryClient());
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
          <AppShell initialProducts={initialProducts} serverNow={serverNow} />
        </SkulletProvider>
      </DisplayPreferencesProvider>
    </QueryClientProvider>
  );
}
function WorkspaceError() {
  const router = useRouter();
  return (
    <main className="workspace-error">
      <img src="/favicon.svg?v=7" width="40" height="40" alt="Piko" />
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
THESIS: Piko is a compact measurement tool with a graphic identity; evidence remains the main content.
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
