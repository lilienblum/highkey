import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { queryReadOnly } from "./api";
import type { LogResult } from "./logs";
import { appendLogPage, MAX_BUFFERED_LOGS } from "./log-buffer";

type LogBody = Record<string, unknown>;
type LogPage = { body: LogBody; result: LogResult };

function combinePages(pages: LogPage[]) {
  return pages
    .slice(1)
    .reduce((result, page) => appendLogPage(result, page.result), pages[0].result);
}

export function useLogFeed(
  product: string | undefined,
  body: LogBody,
  { windowMs, follow, enabled }: { windowMs?: number; follow: boolean; enabled: boolean },
) {
  const client = useQueryClient();
  const queryKey = [
    "logs",
    product,
    windowMs === undefined ? body : { ...body, from: undefined, to: undefined },
    windowMs,
  ];
  const live = follow && windowMs !== undefined;
  const query = useInfiniteQuery({
    queryKey,
    // A source or filter change keeps the previous rows on screen until the new page arrives.
    placeholderData: keepPreviousData,
    enabled: !!product && enabled,
    initialPageParam: undefined as LogBody | undefined,
    queryFn: async ({ pageParam, signal }): Promise<LogPage> => {
      const now = Date.now();
      const request = pageParam ?? {
        ...body,
        ...(windowMs === undefined
          ? {}
          : { from: new Date(now - windowMs).toISOString(), to: new Date(now).toISOString() }),
      };
      return {
        body: request,
        result: await queryReadOnly<LogResult>(
          `/products/${product}/logs/query`,
          request,
          signal,
          "The server is busy. Try again shortly.",
        ),
      };
    },
    getNextPageParam: (_lastPage, pages) => {
      const result = combinePages(pages);
      return result.logs.length < MAX_BUFFERED_LOGS && result.next_cursor
        ? { ...pages[0].body, cursor: result.next_cursor }
        : undefined;
    },
    // The request helper already retries a bounded server-requested capacity delay.
    retry: false,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: live,
    refetchOnReconnect: live,
    refetchInterval: live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const pages = query.data?.pages;
  const data = useMemo(() => pages && combinePages(pages), [pages]);

  async function refresh() {
    if (!product || !enabled) return;
    await client.cancelQueries({ queryKey, exact: true });
    // Infinite queries refetch every retained page; Follow resumes with only the newest page.
    client.setQueryData<InfiniteData<LogPage, LogBody | undefined>>(
      queryKey,
      (previous) => previous && { pages: previous.pages.slice(0, 1), pageParams: [undefined] },
    );
    return query.refetch();
  }

  return {
    data,
    body: pages?.[0].body ?? body,
    pending: enabled && (query.isPending || (query.isFetching && !query.isFetchingNextPage)),
    error: !query.isFetchNextPageError ? query.error?.message : undefined,
    olderPending: query.isFetchingNextPage,
    olderError: query.isFetchNextPageError ? query.error?.message : undefined,
    loadOlder: () => {
      if (enabled && !query.isFetching && query.hasNextPage)
        return query.fetchNextPage({ cancelRefetch: false });
    },
    refresh,
  };
}
