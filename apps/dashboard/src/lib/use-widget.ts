import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
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

class RunFailure extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

type Key = readonly ["widget", string | undefined, string, string, string, string, number];
/**
 * A refresh (a new `refreshKey`, which also moves a rolling end) keeps the previous result in
 * view while it runs; a different widget, start, end or source never borrows another's data.
 */
function sameScope(next: QueryKey, previous: QueryKey | undefined) {
  if (!previous) return false;
  const [, project, widget, from, to, source, refresh] = next as Key;
  const [, lastProject, lastWidget, lastFrom, lastTo, lastSource, lastRefresh] = previous as Key;
  return (
    project === lastProject &&
    widget === lastWidget &&
    from === lastFrom &&
    source === lastSource &&
    (to === lastTo || refresh !== lastRefresh)
  );
}

/**
 * One widget's run through TanStack Query, keyed by its content, range, source and refresh. Runs
 * start only while the widget is near the viewport and share a page-wide limit of three. A
 * `query_timeout` would repeat on retry, so it waits for the reader's Retry; other transient
 * failures surface at once (keeping known data) and retry a few times while the tab is visible
 * and online, as Overview's queries do.
 */
export function useWidgetRun(
  project: string | undefined,
  widget: Widget,
  range: { from: string; to: string },
  sourceId: string | undefined,
  refreshKey: number,
  near: boolean,
) {
  const client = useQueryClient();
  const queryKey: Key = [
    "widget",
    project,
    JSON.stringify(widget),
    range.from,
    range.to,
    sourceId ?? "",
    refreshKey,
  ];
  const keyText = JSON.stringify(queryKey);
  // A timeout would only repeat, so it holds across refreshes of the same scope (live hints,
  // polling) until the reader presses Retry; a new scope runs normally.
  const [held, setHeld] = useState<{ key: QueryKey; failure: RunFailure }>();
  const holding = !!held && JSON.stringify(held.key) !== keyText && sameScope(queryKey, held.key);
  const query = useQuery<RunResult, RunFailure>({
    queryKey,
    enabled: near && !!project && !holding,
    queryFn: async ({ signal }) => {
      const release = await acquire(signal);
      try {
        return await runWidget(
          project as string,
          { widget, from: range.from, to: range.to, source_id: sourceId },
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const timedOut =
          error instanceof ApiError &&
          error.status === 503 &&
          error.payload?.code === "query_timeout";
        throw new RunFailure(
          error instanceof Error ? error.message : "Could not run this widget",
          timedOut,
          !timedOut &&
            (!(error instanceof ApiError) || error.status >= 500 || error.status === 429),
        );
      } finally {
        release();
      }
    },
    placeholderData: (previous, previousQuery) =>
      sameScope(queryKey, previousQuery?.queryKey) ? previous : undefined,
    // Freshness comes from the key: workspace refreshes and live hints change refreshKey.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const failure = query.error ?? (holding ? held?.failure : undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is derived from keyText.
  useEffect(() => {
    if (query.error?.timedOut) setHeld({ key: queryKey, failure: query.error });
  }, [query.error, keyText]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryKey is derived from keyText.
  useEffect(() => {
    setHeld((current) => (current && sameScope(queryKey, current.key) ? current : undefined));
  }, [keyText]);

  // A failed refresh keeps the last result of the same scope next to its error.
  const known = useRef<{ key: QueryKey; data: RunResult }>(undefined);
  if (query.data && !query.isPlaceholderData) known.current = { key: queryKey, data: query.data };
  const data =
    query.data ??
    (failure && known.current && sameScope(queryKey, known.current.key)
      ? known.current.data
      : undefined);

  const attempts = useRef({ key: keyText, count: 0 });
  if (attempts.current.key !== keyText) attempts.current = { key: keyText, count: 0 };
  // Each failed attempt schedules at most one retry; the key text identifies the attempt series.
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

  return {
    data,
    error: failure?.message,
    timedOut: !!failure?.timedOut,
    loading: !data && !failure,
    refreshing: !!data && !failure && (query.isPlaceholderData || query.isFetching),
    retry: () => {
      // A held timeout runs again once released (the key has no result yet); the failed key
      // itself refetches.
      setHeld(undefined);
      if (query.error) void query.refetch();
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
