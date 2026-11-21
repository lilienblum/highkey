import { useEffect, useRef } from "react";
import { useQuery as useCachedQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, queryProduct, type QueryResult } from "./api";
import { browserGcTime } from "./cache-time";

/** A cached result remembers the exact request that produced it. */
type Cached<T> = { request: string; data: T };
class QueryFailure extends Error {
  constructor(
    message: string,
    readonly request: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/**
 * Analytics queries cached by TanStack Query across navigation. The cache key is the product and
 * the caller's logical scope, so returning to a page shows its last result at once while a rolling
 * end time or refresh revalidates it in the background. A different scope never borrows another
 * scope's data. Errors surface on the first failure (keeping known data) and transient failures
 * retry a few times while the tab is visible and online.
 */
export function useQuery(
  product: string | undefined,
  body: Record<string, unknown>,
  refreshKey: string | number = 0,
  backgroundScope?: string,
) {
  return useReportQuery<QueryResult>(
    queryProduct,
    "analytics",
    product,
    body,
    refreshKey,
    backgroundScope,
  );
}

export function useReportQuery<T>(
  load: (product: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<T>,
  kind: string,
  product: string | undefined,
  body: Record<string, unknown>,
  refreshKey: string | number,
  backgroundScope?: string,
  enabled = true,
) {
  const bodyKey = JSON.stringify(body);
  const request = `${refreshKey}:${bodyKey}`;
  const queryKey = [kind, product, backgroundScope ?? bodyKey];
  const client = useQueryClient();
  const query = useCachedQuery<Cached<T>, QueryFailure>({
    queryKey,
    enabled: !!product && enabled,
    queryFn: async ({ signal }) => {
      try {
        return {
          request,
          data: await load(product as string, JSON.parse(bodyKey), signal),
        };
      } catch (error) {
        throw new QueryFailure(
          error instanceof Error ? error.message : "Could not load analytics",
          request,
          !(error instanceof ApiError) || error.status >= 500 || error.status === 429,
        );
      }
    },
    // Freshness is driven by the request identity below and the workspace's live updates.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: browserGcTime(10 * 60_000),
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const cached = query.data;
  const failed = query.error?.request === request ? query.error : undefined;
  const current = cached?.request === request;

  // Revalidate when this scope's request changed (time advanced, refresh, or new options).
  useEffect(() => {
    if (!product || !enabled || query.isFetching || current || failed) return;
    void query.refetch();
  }, [product, enabled, query, current, failed]);

  const attempts = useRef(0);
  const attemptsFor = useRef(request);
  if (attemptsFor.current !== request) {
    attemptsFor.current = request;
    attempts.current = 0;
  }
  // Each failed attempt schedules at most one retry; queryKey is derived from these deps.
  // queryKey changes with product and scope, which also change `failed`.
  useEffect(() => {
    if (!failed?.transient || attempts.current >= 3) return;
    const timer = setTimeout(
      () => {
        if (document.visibilityState === "visible" && navigator.onLine)
          void client.refetchQueries({ queryKey, exact: true });
      },
      1_000 * 2 ** attempts.current++,
    );
    return () => clearTimeout(timer);
  }, [failed, client]);

  return {
    data: cached?.data,
    error: failed?.message,
    loading: !cached && !failed,
    refreshing: !current && !failed,
  };
}
