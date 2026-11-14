import "./dashboards.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Link, useLoaderData, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DashboardSquare01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { api, type Product } from "@/lib/api";
import type { Signal } from "@/lib/change-envelope";
import {
  createDashboard,
  deleteDashboard,
  DocumentError,
  duplicateWidget,
  getDashboard,
  moveWidget,
  removeWidget,
  saveDashboard,
  upsertWidget,
  type DashboardDocument,
  type Issue,
  type Size,
  type StoredDashboard,
} from "@/lib/dashboards";
import { createErrorMessage, useOpenDashboard } from "./new-dashboard-dialog";
import { dashboardRoute, workspaceTarget } from "@/lib/workspace-route";
import { NoProduct, PageHeader, useAnalyticsPending, useWorkspace } from "../app-shell";
import { ErrorState } from "../shared";
import {
  ConflictBanner,
  EditBar,
  UnsavedChangesGuard,
  useWidgetDrag,
  WidgetEditControls,
} from "./edit-controls";
import { WidgetView } from "./widget";

/** The signals a dashboard's widgets read, so live hints for other signals leave it alone. */
export function signalsOf(dashboard: DashboardDocument): Signal[] {
  const signals = new Set<Signal>();
  for (const widget of dashboard.widgets)
    for (const query of Object.values(widget.queries ?? {})) signals.add(query.signal);
  return [...signals].sort();
}

/**
 * A named dashboard: its server-rendered document under the shared toolbar, with each widget
 * loading its own data, and an edit mode that saves the layout against the revision it began from.
 */
export function DashboardPage() {
  const stored = useLoaderData({ from: dashboardRoute });
  const { product } = useWorkspace();
  if (!product) return <NoProduct />;
  if (!stored) return <MissingDashboard product={product} />;
  return <DashboardView key={`${product.id}:${stored.id}`} stored={stored} product={product} />;
}

type EditFailure = { title: string; message: string; issues: Issue[] };

function DashboardView({ stored, product }: { stored: StoredDashboard; product: Product }) {
  const { setLiveSignals, reload } = useWorkspace();
  const router = useRouter();
  // The newest version this page knows: the loader's, or one it saved or fetched itself, which
  // the loader catches up with after its next run.
  const [known, setKnown] = useState(stored);
  const current = known.revision > stored.revision ? known : stored;

  // Edit mode: the draft, the document and revision it started from, and a newer revision.
  const [draft, setDraft] = useState<DashboardDocument | null>(null);
  const [original, setOriginal] = useState<DashboardDocument | null>(null);
  const [baseRevision, setBaseRevision] = useState(stored.revision);
  const [conflict, setConflict] = useState<{ revision: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingTheirs, setLoadingTheirs] = useState(false);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const editing = draft !== null;
  const dirty = useMemo(
    () => draft !== null && JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );
  const dashboard = draft ?? current.document;

  const signals = signalsOf(dashboard).join(",");
  useEffect(() => {
    setLiveSignals(signals ? (signals.split(",") as Signal[]) : []);
    return () => setLiveSignals(null);
  }, [signals, setLiveSignals]);

  // The page is busy while any widget in view loads or refreshes, like Overview's reports.
  const pendingWidgets = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const reportPending = useCallback((id: string, pending: boolean) => {
    if (pending) pendingWidgets.current.add(id);
    else pendingWidgets.current.delete(id);
    setBusy(pendingWidgets.current.size > 0);
  }, []);
  useAnalyticsPending(busy);

  const readsLogs = signals.includes("logs");
  const retention = useQuery({
    queryKey: ["log-retention", product.id],
    enabled: readsLogs,
    queryFn: ({ signal }) =>
      api<{ retention_days: number }>(
        `/products/${encodeURIComponent(product.id)}/logs/settings`,
        "GET",
        undefined,
        signal,
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Controls appear and disappear with edit mode, and React re-inserts a moved card, so focus is
  // placed explicitly once the change has rendered.
  const editButton = useRef<HTMLButtonElement>(null);
  const editBar = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const focusAfterRender = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterRender.current;
    if (!target) return;
    focusAfterRender.current = null;
    target()?.focus();
  });
  const control = (id: string, name: string) =>
    grid.current?.querySelector<HTMLElement>(
      `[data-widget="${CSS.escape(id)}"] [data-edit-control="${name}"]`,
    );

  // A newer revision from a live hint (or any loader run): a clean draft simply moves onto it;
  // changes wait for the reader's choice in the conflict banner.
  useEffect(() => {
    if (!editing || saving || stored.revision <= baseRevision) return;
    if (dirty)
      setConflict((shown) =>
        shown && shown.revision >= stored.revision ? shown : { revision: stored.revision },
      );
    else {
      setDraft(stored.document);
      setOriginal(stored.document);
      setBaseRevision(stored.revision);
      setConflict(null);
    }
  }, [editing, saving, dirty, stored.revision, stored.document, baseRevision]);

  function startEditing() {
    setDraft(current.document);
    setOriginal(current.document);
    setBaseRevision(current.revision);
    setConflict(null);
    setFailure(null);
    setAnnouncement("");
    focusAfterRender.current = () => editBar.current;
  }
  function stopEditing() {
    setDraft(null);
    setOriginal(null);
    setConflict(null);
    setFailure(null);
    focusAfterRender.current = () => editButton.current;
  }
  function cancel() {
    // The view then shows the newest version, which a 409 found before the loader did.
    if (conflict) void router.invalidate({ filter: (match) => match.routeId === dashboardRoute });
    stopEditing();
  }

  async function save(base: number) {
    if (!draft) return;
    setSaving(true);
    setFailure(null);
    try {
      const saved = await saveDashboard(product.id, current.id, base, draft);
      setKnown(saved);
      setBaseRevision(saved.revision);
      stopEditing();
      setAnnouncement("Dashboard saved");
      // Live hints also refresh the document; without channels (Compose) this catches it up.
      void router.invalidate({ filter: (match) => match.routeId === dashboardRoute });
      if (saved.document.name !== current.document.name) void reload().catch(() => undefined);
    } catch (error) {
      if (error instanceof DocumentError && error.code === "revision_conflict")
        setConflict({ revision: error.revision ?? base + 1 });
      else
        setFailure({
          title: "Could not save this dashboard",
          message: error instanceof Error ? error.message : "Try again.",
          issues: error instanceof DocumentError ? error.issues : [],
        });
    } finally {
      setSaving(false);
    }
  }
  function keepMine() {
    if (!conflict) return;
    setBaseRevision(conflict.revision);
    void save(conflict.revision);
  }
  async function loadTheirs() {
    setLoadingTheirs(true);
    setFailure(null);
    try {
      const theirs = await getDashboard(product.slug, current.id);
      setKnown(theirs);
      setDraft(theirs.document);
      setOriginal(theirs.document);
      setBaseRevision(theirs.revision);
      setConflict(null);
      setAnnouncement("Loaded their version");
    } catch (error) {
      setFailure({
        title: "Could not load their version",
        message: error instanceof Error ? error.message : "Try again.",
        issues: [],
      });
    } finally {
      setLoadingTheirs(false);
    }
  }

  function move(id: string, delta: number, refocus: boolean) {
    if (!draft) return;
    const next = moveWidget(draft, id, delta);
    if (next === draft) return;
    const index = next.widgets.findIndex((w) => w.id === id);
    setDraft(next);
    setAnnouncement(
      `${next.widgets[index].title} moved to position ${index + 1} of ${next.widgets.length}`,
    );
    if (refocus) focusAfterRender.current = () => control(id, delta < 0 ? "earlier" : "later");
  }
  function resize(id: string, size: Size) {
    if (!draft) return;
    const widget = draft.widgets.find((w) => w.id === id);
    if (widget) setDraft(upsertWidget(draft, { ...widget, size }));
  }
  function duplicate(id: string) {
    if (!draft) return;
    const index = draft.widgets.findIndex((w) => w.id === id);
    const next = duplicateWidget(draft, id);
    setDraft(next);
    setAnnouncement(`Added ${next.widgets[index + 1].title} after the original`);
  }
  function remove(id: string) {
    if (!draft) return;
    const index = draft.widgets.findIndex((w) => w.id === id);
    const next = removeWidget(draft, id);
    setDraft(next);
    setAnnouncement(`Removed ${draft.widgets[index].title}`);
    // Focus moves to the card that took its place, or the one before, or the edit bar.
    const neighbour = next.widgets[index] ?? next.widgets[index - 1];
    focusAfterRender.current = () =>
      neighbour ? control(neighbour.id, "earlier") : editBar.current;
  }

  const ids = dashboard.widgets.map((widget) => widget.id);
  const drag = useWidgetDrag(grid, ids, (id, delta) => move(id, delta, false));

  return (
    <>
      <PageHeader title={dashboard.name} description={dashboard.description ?? ""}>
        {!editing && (
          <DashboardActions
            stored={current}
            product={product}
            onEdit={startEditing}
            editRef={editButton}
          />
        )}
      </PageHeader>
      {editing && (
        <EditBar
          ref={editBar}
          dirty={dirty}
          saving={saving}
          saveDisabled={!!conflict || loadingTheirs}
          onSave={() => void save(baseRevision)}
          onCancel={cancel}
        />
      )}
      {editing && conflict && (
        <ConflictBanner
          project={product.slug}
          dashboard={current.id}
          revision={conflict.revision}
          busy={saving || loadingTheirs}
          onLoadTheirs={() => void loadTheirs()}
          onKeepMine={keepMine}
        />
      )}
      {editing && failure && (
        <Alert variant="destructive" className="dashboard-edit-failure">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            <p>{failure.message}</p>
            {failure.issues.length > 0 && (
              <ul>
                {failure.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    <code>{issue.path || "/"}</code> {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      {dashboard.widgets.length ? (
        <div
          className="dashboard-grid"
          data-editing={editing ? "" : undefined}
          {...(editing ? drag.gridProps : {})}
          ref={grid}
        >
          {dashboard.widgets.map((widget, index) => (
            <WidgetView
              key={widget.id}
              widget={widget}
              product={product}
              logRetentionDays={retention.data?.retention_days}
              onPendingChange={reportPending}
              dragging={drag.dragging === widget.id}
              editControls={
                editing ? (
                  <WidgetEditControls
                    widget={widget}
                    index={index}
                    count={dashboard.widgets.length}
                    onMove={(delta) => move(widget.id, delta, true)}
                    onResize={(size) => resize(widget.id, size)}
                    onDuplicate={() => duplicate(widget.id)}
                    onRemove={() => remove(widget.id)}
                  />
                ) : undefined
              }
            />
          ))}
          {editing && drag.indicator}
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No widgets yet</EmptyTitle>
            <EmptyDescription>
              Widgets added to this dashboard, in Piko or by your AI through MCP, appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-dashboard-announcer="">
        {announcement}
      </div>
      <UnsavedChangesGuard dirty={dirty} />
    </>
  );
}

/**
 * Edit, then the dashboard's overflow menu. Copy JSON hands the stored document to the clipboard;
 * Duplicate saves a copy and opens it; Delete asks first. Failures show under the heading.
 */
function DashboardActions({
  stored,
  product,
  onEdit,
  editRef,
}: {
  stored: StoredDashboard;
  product: Product;
  onEdit: () => void;
  editRef: Ref<HTMLButtonElement>;
}) {
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  const open = useOpenDashboard();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyJson() {
    setError("");
    try {
      await navigator.clipboard.writeText(JSON.stringify(stored.document, null, 2));
      setCopied(true);
    } catch {
      setError("Could not copy to the clipboard. Allow clipboard access and try again.");
    }
  }
  async function duplicate() {
    setError("");
    try {
      const name = `${stored.document.name} copy`.slice(0, 80);
      await open(await createDashboard(product.id, { ...stored.document, name }));
    } catch (e) {
      setError(createErrorMessage(e));
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await deleteDashboard(product.id, stored.slug);
      setConfirming(false);
      await reload();
      await navigate(workspaceTarget("/", product.slug));
    } catch (e) {
      setConfirming(false);
      setError(e instanceof Error ? e.message : "Could not delete the dashboard.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dashboard-actions">
      {copied && (
        <span role="status" className="dashboard-actions-status">
          Copied
        </span>
      )}
      <Button ref={editRef} variant="outline" onClick={onEdit}>
        <HugeiconsIcon
          icon={PencilEdit02Icon}
          strokeWidth={2}
          aria-hidden="true"
          data-icon="inline-start"
        />
        Edit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button ref={trigger} variant="outline" size="icon" aria-label="Dashboard actions" />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={() => void duplicate()}>Duplicate</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyJson()}>Copy JSON</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <Alert variant="destructive" role="alert" className="dashboard-actions-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <AlertDialog open={confirming} onOpenChange={(next) => !busy && setConfirming(next)}>
        <AlertDialogContent finalFocus={trigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {stored.document.name}? Its revisions are deleted too.
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your events, logs and other dashboards are not affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              Delete dashboard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MissingDashboard({ product }: { product: Product }) {
  return (
    <>
      <PageHeader
        title="This dashboard no longer exists"
        description="It may have been deleted. The project’s other dashboards and its data are unchanged."
      />
      <Button
        variant="outline"
        nativeButton={false}
        role="link"
        render={<Link {...workspaceTarget("/", product.slug)} />}
      >
        Go to Overview
      </Button>
    </>
  );
}

/** A failed document load keeps the shell and offers a retry. */
export function DashboardError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <ErrorState
      message={error instanceof Error ? error.message : "Could not load this dashboard."}
      retry={() => void router.invalidate({ filter: (match) => match.routeId === dashboardRoute })}
    />
  );
}
