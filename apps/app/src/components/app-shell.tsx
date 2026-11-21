import { useQueryClient } from "@tanstack/react-query";
import { validateExploreSearch } from "@/lib/explore-search";
import { validateLogsSearch } from "@/lib/logs";
import { presetRange } from "@/lib/date-range";
import { DateRangePicker } from "./date-range-picker";
import { isOrganizationPage, useWorkspaceTarget, workspaceView } from "@/lib/workspace-route";
import { dashboardQueries } from "@/server/dashboards";
import { viewQueries } from "@/lib/views";
import { ProjectIcon } from "./project-icon";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ValueSelect } from "./value-select";
import { oversees, useOrganizationRole } from "./settings/settings-nav";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { WorkspaceSidebar } from "./workspace-sidebar";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { api, type Product, type Source } from "@/lib/api";
import { readPreference, savePreference } from "@/lib/preferences";
import { findSource, sourceParam } from "@/lib/workspace-search";
import { ErrorState } from "./shared";
import { PageLoading } from "./loading";
import { LiveUpdates } from "./live-updates";
import { NotificationToast } from "./notifications";
import type { Signal } from "@/lib/change-envelope";

type Context = {
  products: Product[];
  product?: Product;
  source?: Source;
  sourceId?: string;
  reload: (select?: string) => Promise<void>;
  range: { from: string; to: string };
  /**
   * The selected dates rather than their timestamps: a rolling range keeps one scope while its end
   * advances, so cached results stay in view while they refresh.
   */
  rangeScope: string;
  refresh: () => void;
  refreshKey: number;
  now: number;
  setAnalyticsPending: (pending: boolean) => void;
  /** Applies an explicit range, as the date picker's custom range does (charts use it to zoom). */
  selectRange: (range: { from: string; to: string }) => void;
  /** The signals whose live hints refresh the current page; `null` restores the default (events). */
  setLiveSignals: (signals: Signal[] | null) => void;
};
const Workspace = createContext<Context | null>(null);
export function useWorkspace() {
  const value = useContext(Workspace);
  if (!value) throw new Error("Missing workspace");
  return value;
}
export function useAnalyticsPending(pending: boolean) {
  const { setAnalyticsPending } = useWorkspace();
  useEffect(() => {
    setAnalyticsPending(pending);
    return () => setAnalyticsPending(false);
  }, [pending, setAnalyticsPending]);
}
export function AppShell({
  initialProducts,
  serverNow,
}: {
  initialProducts: Product[];
  serverNow: number;
}) {
  const workspaceTarget = useWorkspaceTarget();
  const canCreate = oversees(useOrganizationRole());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [analyticsPending, setAnalyticsPending] = useState(false);
  const [liveSignals, setLiveSignals] = useState<Signal[] | null>(null);
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [selected, setSelected] = useState("");
  const [sourceSelection, setSourceSelection] = useState<Record<string, string>>({});
  const [savedDays, setSavedDays] = useState<7 | 30 | 90>(7);
  // Starting from the server's clock keeps rolling ranges identical through hydration.
  const [now, setNow] = useState(serverNow);
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshBackground = useCallback(() => {
    setNow(Date.now());
    // Fixed-date drilldowns also need invalidation when late events arrive.
    setRefreshKey((key) => key + 1);
  }, []);
  const [error, setError] = useState("");
  const path = useLocation({ select: (l) => l.pathname });
  const view = workspaceView(path);
  const { projectSlug, dashboardSlug } = useParams({ strict: false });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: "__root__" });
  const currentSearch = useSearch({ strict: false });
  const drilldown = view === "/events" ? currentSearch.drilldown : undefined;
  const requestedProject = projectSlug ?? search.project;
  const days = search.days ?? (requestedProject ? 7 : savedDays);
  useEffect(() => {
    setSidebarOpen(readPreference("highkey:sidebar") !== "collapsed");
    setSelected(readPreference("highkey:product") ?? "");
    const saved = Number(readPreference("highkey:days"));
    if ([7, 30, 90].includes(saved)) setSavedDays(saved as 7 | 30 | 90);
    setPreferencesReady(true);
  }, []);
  // The catalog arrives with the server render and later refreshes through reload(); only the
  // browser-saved source choices need restoring here. A workspace retry remounts the shell.
  useEffect(() => {
    setSourceSelection(
      Object.fromEntries(
        initialProducts.map((product) => [
          product.id,
          readPreference(`highkey:source:${product.id}`) ?? "",
        ]),
      ),
    );
  }, [initialProducts]);
  useLayoutEffect(() => {
    if (preferencesReady) delete document.documentElement.dataset.sidebarInitial;
  }, [preferencesReady]);
  function selectProject(project: Product) {
    return navigate({
      ...workspaceTarget(view, project.slug),
      search: {
        source: "all",
        days: 7,
        // Explicitly clear the dates retained by the root search middleware.
        period: undefined,
        snapshot: undefined,
        from: undefined,
        to: undefined,
      },
      resetScroll: false,
    });
  }
  async function reload(select?: string) {
    const result = await api<Product[]>("/products");
    setProducts(result);
    if (select) {
      setSelected(select);
      savePreference("highkey:product", select);
      const project = result.find((p) => p.id === select);
      if (project) await selectProject(project);
    }
    setError("");
  }
  const product = search.invalidWorkspace
    ? undefined
    : requestedProject
      ? products.find((p) => p.slug === requestedProject)
      : drilldown?.productId
        ? products.find((p) => p.id === drilldown.productId)
        : (products.find((p) => p.id === selected) ?? products[0]);
  const requestedSource = drilldown
    ? (drilldown.sourceId ?? "all")
    : (search.source ?? (requestedProject ? "all" : (sourceSelection[product?.id ?? ""] ?? "all")));
  // URLs name sources by slug; IDs come from older links, drilldowns and saved choices.
  const source = findSource(product?.sources, requestedSource);
  const sourceId = source?.id;
  const sourceValue = sourceParam(product?.sources, sourceId);
  const missingSource = !!requestedSource && requestedSource !== "all" && !source;
  const selectionError =
    search.invalidWorkspace ||
    (requestedProject && !product) ||
    (product && drilldown?.productId && product.id !== drilldown.productId) ||
    (!drilldown && search.source && missingSource);
  // Organization and account pages need no project, so nothing resolves or redirects there.
  const organizationPage = isOrganizationPage(path);
  const resolvingProject =
    !organizationPage &&
    !!product &&
    !projectSlug &&
    !selectionError &&
    !(drilldown && missingSource);
  useEffect(() => {
    if (
      organizationPage ||
      !preferencesReady ||
      !product ||
      selectionError ||
      (drilldown && missingSource)
    )
      return;
    savePreference("highkey:product", product.id);
    savePreference("highkey:days", String(days));
    savePreference(`highkey:source:${product.id}`, sourceId ?? "");
    if (
      projectSlug !== product.slug ||
      search.project !== undefined ||
      search.source !== sourceValue ||
      search.days !== days
    )
      void navigate({
        ...workspaceTarget(view, product.slug, dashboardSlug),
        search: (previous) => ({
          ...previous,
          project: undefined,
          source: sourceValue,
          days,
        }),
        hash: true,
        replace: true,
        resetScroll: false,
      });
  }, [
    preferencesReady,
    product,
    selectionError,
    drilldown,
    missingSource,
    days,
    sourceId,
    sourceValue,
    projectSlug,
    dashboardSlug,
    view,
    search.project,
    search.source,
    search.days,
    navigate,
    workspaceTarget,
    organizationPage,
  ]);
  const rangeIdentity = JSON.stringify([
    view,
    product?.id,
    sourceId,
    days,
    search.period,
    search.snapshot,
    search.from,
    search.to,
    drilldown,
  ]);
  const [rangePath, setRangePath] = useState(rangeIdentity);
  // Canonicalizing a bare URL does not restart queries; changing actual scope does.
  if (rangePath !== rangeIdentity) {
    setRangePath(rangeIdentity);
    setNow(Date.now());
  }
  const defaultRange = useMemo(() => {
    if (search.from && search.to) return { from: search.from, to: search.to };
    if (search.period) return presetRange(search.period, now);
    const end = new Date(search.snapshot ?? now);
    const start = new Date(end);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - days + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [days, now, search.period, search.snapshot, search.from, search.to]);
  const range = drilldown ? { from: drilldown.from, to: drilldown.to } : defaultRange;
  const rangeScope = JSON.stringify([
    days,
    search.period,
    search.snapshot,
    search.from,
    search.to,
    drilldown,
  ]);
  const refresh = () => {
    refreshBackground();
    if (error) void reload().catch((e) => setError(e.message));
  };
  const selectRange = (next: { from: string; to: string }) =>
    void navigate({
      ...workspaceTarget(view, product?.slug, dashboardSlug),
      search: (previous) => ({
        ...previous,
        period: undefined,
        from: next.from,
        to: next.to,
        snapshot: undefined,
        drilldown: previous.drilldown ? { ...previous.drilldown, ...next } : undefined,
        page: undefined,
      }),
      resetScroll: false,
    });
  const label = (
    {
      "/": "Overview",
      "/events": "Events",
      "/revenue": "Revenue",
      "/sessions": "Sessions",
      "/realtime": "Realtime",
      "/people": "Profiles",
      "/ai": "AI costs",
      "/logs": "Logs",
      "/settings": "Settings",
      "/dashboards": "Dashboard",
    } as const
  )[view];
  // A dashboard, view or source changed elsewhere (or while disconnected): refresh the sidebar's
  // lists and the open dashboard or saved view in the background. A failed read keeps what is shown.
  const dashboardsChanged = () => {
    void queryClient.refetchQueries({
      queryKey: ["chart-references", product?.id],
      type: "active",
    });
    void queryClient.refetchQueries({ queryKey: ["event-catalog", product?.id], type: "active" });
    void reload().catch(() => undefined);
    void queryClient.refetchQueries({ queryKey: dashboardQueries, type: "active" });
    void queryClient.refetchQueries({ queryKey: viewQueries, type: "active" });
  };
  const projectPicker = (
    <ValueSelect
      label="Select project"
      value={product?.id ?? ""}
      disabled={!products.length && !canCreate}
      placeholder={
        drilldown || requestedProject || selectionError ? "Project unavailable" : "No projects yet"
      }
      className="product-select"
      contentClassName="min-w-56 max-w-[calc(100vw-32px)]"
      icon={<ProjectIcon product={product} />}
      action={
        canCreate
          ? {
              label: "New project",
              icon: <HugeiconsIcon icon={Add01Icon} aria-hidden="true" />,
              onSelect: () => window.location.assign("/new"),
            }
          : undefined
      }
      onValueChange={(value) => {
        const project = products.find((p) => p.id === value);
        if (project) void selectProject(project);
      }}
      options={products.map((p) => [p.id, p.name, <ProjectIcon key={p.id} product={p} />])}
    />
  );
  return (
    <Workspace.Provider
      value={{
        products,
        product,
        source,
        sourceId,
        reload,
        range,
        rangeScope,
        refresh,
        refreshKey,
        now,
        setAnalyticsPending,
        selectRange,
        setLiveSignals,
      }}
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={(open) => {
          setSidebarOpen(open);
          savePreference("highkey:sidebar", open ? "expanded" : "collapsed");
        }}
        style={{ "--sidebar-width": "15rem", "--sidebar-width-icon": "3.5rem" } as CSSProperties}
        // Server-rendered pages are visible before hydration; until then they ignore input, so an
        // early click or form submit cannot half-work or reload the page. aria-disabled also makes
        // automation (which can set values without focus) wait for the interactive page.
        inert={!preferencesReady}
        aria-disabled={preferencesReady ? undefined : true}
      >
        <WorkspaceSidebar
          path={view}
          dashboardSlug={view === "/dashboards" ? dashboardSlug : undefined}
          eventViewSlug={view === "/events" ? currentSearch.view : undefined}
          logViewSlug={view === "/logs" ? currentSearch.view : undefined}
          product={product}
          sourceId={sourceId}
          picker={projectPicker}
          navigationReady={preferencesReady}
          onSourceChange={(id) => {
            if (!product) return;
            void navigate({
              ...workspaceTarget(view === "/settings" ? "/" : view, product.slug, dashboardSlug),
              search: {
                // The Events query and open view, or the log filters, carry over to the new
                // source; a page number or log cursor does not.
                ...(view === "/events" ? eventFilters(currentSearch) : {}),
                ...(view === "/logs" ? logFilters(currentSearch) : {}),
                project: undefined,
                source: sourceParam(product.sources, id),
                days,
                period: search.period,
                snapshot: search.snapshot,
                from: search.from,
                to: search.to,
              },
              resetScroll: false,
            });
          }}
        />
        <SidebarInset id="main-content" tabIndex={-1} className="min-w-0">
          <LiveUpdates
            productId={selectionError ? undefined : product?.id}
            view={view}
            scopeKey={JSON.stringify([
              product?.id,
              sourceId,
              days,
              drilldown,
              search.period,
              search.snapshot,
              search.from,
              search.to,
              view,
              dashboardSlug,
            ])}
            busy={resolvingProject || analyticsPending}
            onRefresh={refreshBackground}
            signals={liveSignals ?? undefined}
            minIntervalMs={view === "/dashboards" ? 30_000 : 1_500}
            onDashboardsChanged={dashboardsChanged}
          />
          <div
            className="page-content"
            data-page={label.toLowerCase()}
            aria-busy={resolvingProject || analyticsPending}
          >
            <div className="workspace-toolbar-navigation">
              <SidebarTrigger disabled={!preferencesReady} />
              <div className="mobile-project-picker">{projectPicker}</div>
              <span className="workspace-source-name">{source?.name ?? "All sources"}</span>
            </div>
            {view !== "/settings" && view !== "/logs" && view !== "/realtime" && (
              <div className="workspace-toolbar">
                <div className="workspace-toolbar-actions">
                  <DateRangePicker
                    days={days}
                    period={search.period}
                    onPreset={(preset) => {
                      void navigate({
                        ...workspaceTarget(view, product?.slug, dashboardSlug),
                        search: (previous) => ({
                          ...previous,
                          days: typeof preset === "number" ? preset : days,
                          period: typeof preset === "string" ? preset : undefined,
                          snapshot: undefined,
                          from: undefined,
                          to: undefined,
                          drilldown: undefined,
                          invalidDrilldown: undefined,
                          page: undefined,
                        }),
                        resetScroll: false,
                      });
                    }}
                    range={range}
                    fixed={!!(drilldown || search.snapshot || search.from)}
                    disabled={!preferencesReady || !product || !!selectionError}
                    onApply={selectRange}
                  />
                </div>
              </div>
            )}
            {error && <ErrorState message={error} retry={refresh} />}
            {product && !resolvingProject && !selectionError && !isOrganizationPage(path) && (
              <NotificationToast key={product.id} project={product.id} />
            )}
            {resolvingProject ? (
              <>
                <PageHeader title={label} description="Your project analytics" />
                <PageLoading label="Loading workspace" />
              </>
            ) : selectionError ? (
              <>
                <PageHeader
                  title="This selection is unavailable"
                  description="The link contains an invalid date range, or its project or source is not in this workspace."
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/",
                      search: {
                        project: undefined,
                        source: undefined,
                        days: undefined,
                        snapshot: undefined,
                        from: undefined,
                        to: undefined,
                        invalidWorkspace: undefined,
                      },
                    })
                  }
                >
                  Clear selection
                </Button>
              </>
            ) : (
              (!error || products.length > 0) && <Outlet />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </Workspace.Provider>
  );
}
function eventFilters(current: Record<string, unknown>) {
  const { query, view, viewAt, pageSize } = validateExploreSearch(current);
  return { query, view, viewAt, pageSize };
}
function logFilters(current: Record<string, unknown>) {
  const { logBefore: _cursor, invalidLogs: _invalid, ...filters } = validateLogsSearch(current);
  return filters;
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
export function NoProduct() {
  return (
    <>
      <PageHeader
        title="Create your first project"
        description="Websites, CLIs, and everything you’re building."
      />
      <Empty>
        <EmptyHeader>
          <EmptyTitle>One workspace for every project</EmptyTitle>
          <EmptyDescription>
            Create a project to get its own analytics and ingestion keys.
          </EmptyDescription>
        </EmptyHeader>
        <Button nativeButton={false} role="link" render={<a href="/new" />}>
          <HugeiconsIcon
            icon={Add01Icon}
            strokeWidth={2}
            aria-hidden="true"
            data-icon="inline-start"
          />
          Create a project
        </Button>
      </Empty>
    </>
  );
}
