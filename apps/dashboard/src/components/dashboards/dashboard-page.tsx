import "./dashboards.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Link, useLoaderData, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { api, type Product } from "@/lib/api";
import type { Signal } from "@/lib/change-envelope";
import { deleteDashboard, type DashboardDocument, type StoredDashboard } from "@/lib/dashboards";
import { AgentGuide, AgentGuideDialog } from "./agent-guide";
import { RevisionsSheet } from "./revisions-sheet";
import { DashboardNameDialog } from "./new-dashboard-dialog";
import { dashboardRoute, workspaceTarget } from "@/lib/workspace-route";
import { NoProduct, PageHeader, useAnalyticsPending, useWorkspace } from "../app-shell";
import { ErrorState } from "../shared";
import { WidgetView } from "./widget";

/** The signals a dashboard's widgets read, so live hints for other signals leave it alone. */
export function signalsOf(dashboard: DashboardDocument): Signal[] {
  const signals = new Set<Signal>();
  for (const widget of dashboard.widgets)
    for (const query of Object.values(widget.queries ?? {}))
      signals.add(query.signal === "sql" ? query.database : query.signal);
  return [...signals].sort();
}

/**
 * A named dashboard: its server-rendered document under the shared toolbar, with each widget
 * loading its own data.
 */
export function DashboardPage() {
  const stored = useLoaderData({ from: dashboardRoute });
  const { product } = useWorkspace();
  if (!product) return <NoProduct />;
  if (!stored) return <MissingDashboard product={product} />;
  return <DashboardView key={`${product.id}:${stored.id}`} stored={stored} product={product} />;
}

function DashboardView({ stored, product }: { stored: StoredDashboard; product: Product }) {
  const { setLiveSignals } = useWorkspace();
  const dashboard = stored.document;
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

  return (
    <>
      <PageHeader title={dashboard.name} description={dashboard.description ?? ""}>
        <DashboardActions stored={stored} product={product} />
      </PageHeader>
      {dashboard.widgets.length ? (
        <div className="dashboard-grid">
          {dashboard.widgets.map((widget) => (
            <WidgetView
              key={widget.id}
              widget={widget}
              product={product}
              logRetentionDays={retention.data?.retention_days}
              onPendingChange={reportPending}
            />
          ))}
        </div>
      ) : (
        <section className="dashboard-empty" aria-labelledby="dashboard-empty-title">
          <h2 id="dashboard-empty-title" className="dashboard-empty-title">
            No widgets yet
          </h2>
          <p className="dashboard-empty-description">
            Your agent adds widgets over MCP. Connect it, then ask for what you want to see.
          </p>
          <AgentGuide
            intent={{
              type: "edit-dashboard",
              dashboard: { slug: stored.slug, name: dashboard.name, revision: stored.revision },
            }}
            project={product}
          />
        </section>
      )}
    </>
  );
}

/**
 * The dashboard's overflow menu. Copy JSON hands the stored document to the clipboard; Duplicate
 * asks for the copy's name and opens it; Edit shows how to change the dashboard through an agent; Delete asks first. Failures show under the heading.
 */
function DashboardActions({ stored, product }: { stored: StoredDashboard; product: Product }) {
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [revising, setRevising] = useState(false);
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
  async function refreshDashboard() {
    await router.invalidate({ filter: (match) => match.routeId === dashboardRoute });
    await reload();
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
      <Button type="button" variant="outline" onClick={() => setGuiding(true)}>
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
          <DropdownMenuItem onClick={() => setDuplicating(true)}>Duplicate</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyJson()}>Copy JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRevising(true)}>Revisions</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AgentGuideDialog
        open={guiding}
        onOpenChange={setGuiding}
        intent={{
          type: "edit-dashboard",
          dashboard: { slug: stored.slug, name: stored.document.name, revision: stored.revision },
        }}
        project={product}
      />
      <RevisionsSheet
        productId={product.id}
        dashboard={{ slug: stored.slug, revision: stored.revision }}
        open={revising}
        onOpenChange={setRevising}
        onRestored={refreshDashboard}
        finalFocus={trigger}
      />
      <DashboardNameDialog
        open={duplicating}
        onOpenChange={setDuplicating}
        title="Duplicate dashboard"
        description="The copy keeps every widget and opens when it is saved."
        initialName={`${stored.document.name} copy`.slice(0, 80)}
        submitLabel="Duplicate"
        build={(name) => ({ ...stored.document, name })}
        finalFocus={trigger}
      />
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
