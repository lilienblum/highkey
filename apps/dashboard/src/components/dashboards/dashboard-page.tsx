import "./dashboards.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { DashboardSquare01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { api, type Product } from "@/lib/api";
import type { Signal } from "@/lib/change-envelope";
import type { DashboardDocument, StoredDashboard } from "@/lib/dashboards";
import { dashboardRoute, workspaceTarget } from "@/lib/workspace-route";
import { NoProduct, PageHeader, useAnalyticsPending, useWorkspace } from "../app-shell";
import { ErrorState } from "../shared";
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
 * loading its own data. Edit mode builds on this page.
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
      <PageHeader title={dashboard.name} description={dashboard.description ?? ""} />
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
    </>
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
