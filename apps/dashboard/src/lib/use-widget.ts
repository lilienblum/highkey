import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { runWidget, type RunResult, type Widget } from "./dashboards";

/** At most this many widget runs per page, so one dashboard never floods the API's query gate. */
const CONCURRENT_RUNS = 3;
let running = 0;
const waiting: (() => void)[] = [];

/** Waits for a run slot. A released slot passes straight to the next waiter, so none is lost. */
async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (running < CONCURRENT_RUNS) running++;
  else
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = waiting.indexOf(ready);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
}

/** A cached run remembers the exact request (range and refresh) that produced it. */
type Cached = { request: string; result: RunResult };
class RunFailure extends Error {
  constructor(
    message: string,
    readonly request: string,
    readonly timedOut: boolean,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/**
 * One widget's run through TanStack Query, cached by project, widget, selected range and source,
 * so returning to a dashboard shows its last results at once while a rolling end or a refresh
 * revalidates them in the background; a different scope never borrows another's data. Runs start
 * only while the widget is near the viewport and share a page-wide limit of three. A
 * `query_timeout` would repeat on retry, so it holds across refreshes of the same scope until the
 * reader's Retry; other transient failures surface at once (keeping known data) and retry a few
 * times while the tab is visible and online, as Overview's queries do.
 */
export function useWidgetRun(
  project: string | undefined,
  widget: Widget,
  range: { from: string; to: string },
  rangeScope: string,
  sourceId: string | undefined,
  refreshKey: number,
  near: boolean,
) {
  const client = useQueryClient();
  const widgetKey = JSON.stringify(widget);
  const queryKey = ["widget", project, widgetKey, rangeScope, sourceId ?? ""] as const;
  const keyText = JSON.stringify(queryKey);
  const request = JSON.stringify([range.from, range.to, refreshKey]);
  // A timeout during this visit holds its scope until Retry; a return visit or a scope that has
  // not timed out runs as usual. The hold decides whether the query may run, so it reads the
  // scope's cached state directly.
  const [holdFrom, setHoldFrom] = useState(() => Date.now());
  const last = client.getQueryState<Cached, RunFailure>(queryKey);
  const holding = !!last?.error?.timedOut && last.errorUpdatedAt >= holdFrom;
  const query = useQuery<Cached, RunFailure>({
    queryKey,
    enabled: near && !!project && !holding,
    queryFn: async ({ signal }) => {
      const release = await acquire(signal);
      try {
        return {
          request,
          result: await runWidget(
            project as string,
            { widget, from: range.from, to: range.to, source_id: sourceId },
            signal,
          ),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        const timedOut =
          error instanceof ApiError &&
          error.status === 503 &&
          error.payload?.code === "query_timeout";
        throw new RunFailure(
          error instanceof Error ? error.message : "Could not run this widget",
          request,
          timedOut,
          !timedOut &&
            (!(error instanceof ApiError) || error.status >= 500 || error.status === 429),
        );
      } finally {
        release();
      }
    },
    // Freshness is driven by the request identity below and the workspace's live updates.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const cached = query.data;
  const current = cached?.request === request;
  const failure =
    query.error && (query.error.request === request || holding) ? query.error : undefined;

  // Revalidate when this scope's request changed (time advanced or a refresh), as Overview does.
  useEffect(() => {
    if (!near || !project || query.isFetching || current || failure) return;
    void query.refetch();
  }, [near, project, query, current, failure]);

  const attempts = useRef({ request: "", count: 0 });
  if (attempts.current.request !== `${keyText}:${request}`)
    attempts.current = { request: `${keyText}:${request}`, count: 0 };
  // Each failed attempt schedules at most one retry; the key and request identify the series.
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is derived from keyText.
  useEffect(() => {
    if (!failure?.transient || attempts.current.count >= 3) return;
    const timer = setTimeout(
      () => {
        if (document.visibilityState === "visible" && navigator.onLine)
          void client.refetchQueries({ queryKey, exact: true });
      },
      1_000 * 2 ** attempts.current.count++,
    );
    return () => clearTimeout(timer);
  }, [failure, client, keyText]);

  const data = cached?.result;
  return {
    data,
    error: failure?.message,
    timedOut: !!failure?.timedOut,
    loading: !data && !failure,
    refreshing: !!data && !failure && (!current || query.isFetching),
    retry: () => {
      // Releases a held timeout; a later timeout holds again.
      setHoldFrom(Date.now());
      void query.refetch();
    },
  };
}

/** Whether the element is within 200px of the viewport; widgets outside it do not run. */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}
