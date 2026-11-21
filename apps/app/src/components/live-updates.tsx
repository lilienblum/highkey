import { useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChangeChannel } from "@/lib/use-change-channel";
import { matches, parseChangeEnvelope, type Signal } from "@/lib/change-envelope";

interface Props {
  productId?: string;
  view: string;
  scopeKey: string;
  busy: boolean;
  onRefresh: () => void;
  /** Signals that make the current view refresh. Defaults to events. */
  signals?: Signal[];
  /** Minimum spacing between refreshes. Defaults to 1,500 ms. */
  minIntervalMs?: number;
  /** Called for a dashboards signal on the current product, with no cadence limit. */
  onDashboardsChanged?: () => void;
}

const EVENTS: Signal[] = ["events"];
const REFRESH_VIEWS = ["/", "/events", "/dashboards", "/revenue", "/sessions", "/people"];

export function LiveUpdates(props: Props) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = async () => {
      try {
        const response = await fetch("/_highkey/runtime", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) throw new Error("Runtime configuration unavailable");
        const runtime = await response.json();
        if (typeof runtime?.live !== "boolean") throw new Error("Invalid runtime configuration");
        if (!controller.signal.aborted) setEnabled(runtime.live);
      } catch {
        if (!controller.signal.aborted)
          timer = setTimeout(load, Math.min(1_000 * 2 ** attempts++, 30_000));
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return <AutomaticUpdates {...props} live={enabled} />;
}

function AutomaticUpdates({
  productId,
  view,
  scopeKey,
  busy,
  onRefresh,
  signals = EVENTS,
  minIntervalMs = 1_500,
  onDashboardsChanged,
  live,
}: Props & { live: boolean }) {
  const [dirty, setDirty] = useState(false);
  const [available, setAvailable] = useState(true);
  const lastRefresh = useRef(0);
  const previousScope = useRef(scopeKey);
  const markDirty = useCallback(() => setDirty(true), []);
  // Read at tick time so a new callback or the runtime answer never restarts the cadence timer.
  const pollOnly = useRef(!live);
  pollOnly.current = !live;
  const dashboardsChanged = useRef(onDashboardsChanged);
  dashboardsChanged.current = onDashboardsChanged;
  useEffect(() => {
    // The cadence starts with the page (or its new scope), which has just loaded fresh results,
    // so the first catch-up (a connection reconcile, say) also waits minIntervalMs.
    lastRefresh.current = Date.now();
    if (previousScope.current !== scopeKey) {
      previousScope.current = scopeKey;
      setDirty(false);
    }
  }, [scopeKey]);
  useEffect(() => {
    const available = () => document.visibilityState === "visible" && navigator.onLine;
    const resume = () => {
      const ready = available();
      setAvailable(ready);
      if (ready) markDirty();
    };
    setAvailable(available());
    // Reconcile even without channels: ephemeral hints may be lost, or collection
    // may be running in standalone mode. Hidden/offline tabs do no polling work.
    const timer = setInterval(() => {
      if (!available()) return;
      markDirty();
      // Without channels nothing signals a dashboard, view or source an agent saved, so every
      // page (Logs and Settings too) polls for them. With channels, those signals arrive on their own.
      if (pollOnly.current) dashboardsChanged.current?.();
    }, 30_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [markDirty]);
  useEffect(() => {
    if (!dirty || !available || busy || !productId || !REFRESH_VIEWS.includes(view)) return;
    // At most one refresh in flight and one queued. Bursts share a short timer.
    const delay = Math.max(750, minIntervalMs - (Date.now() - lastRefresh.current));
    const timer = setTimeout(() => {
      lastRefresh.current = Date.now();
      setDirty(false);
      onRefresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [dirty, available, busy, productId, view, onRefresh, minIntervalMs]);
  return live ? (
    <ChangeSubscription
      productId={productId}
      signals={signals}
      onChange={markDirty}
      onDashboardsChanged={onDashboardsChanged}
    />
  ) : null;
}

function ChangeSubscription({
  productId,
  signals,
  onChange,
  onDashboardsChanged,
}: {
  productId?: string;
  signals: Signal[];
  onChange: () => void;
  onDashboardsChanged?: () => void;
}) {
  const previousStatus = useRef("connecting");
  const dashboardsChanged = useRef(onDashboardsChanged);
  dashboardsChanged.current = onDashboardsChanged;
  const { viewer } = useRouteContext({ from: "__root__" });
  const { status } = useChangeChannel(viewer?.activeOrganizationId ?? null, (message) => {
    if (message.type !== "changed" || !productId) return;
    const change = parseChangeEnvelope(message.data);
    if (!change) return;
    if (matches(change, productId, signals)) onChange();
    if (matches(change, productId, ["dashboards"])) dashboardsChanged.current?.();
  });
  useEffect(() => {
    // No replay: reconcile every connection, including the initial subscription, so changes to
    // data and to dashboards made while disconnected are both picked up.
    if (status === "open" && previousStatus.current !== "open") {
      onChange();
      dashboardsChanged.current?.();
    }
    previousStatus.current = status;
  }, [status, onChange]);
  return null;
}
