import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { StoredDashboard } from "../lib/dashboards";
import { browserGcTime } from "../lib/cache-time";

/** Project and dashboard keys are slugs or UUIDs; anything else cannot name one. */
const key = /^[A-Za-z0-9-]{1,128}$/;

/**
 * One dashboard document for the server render and the browser. A missing project or dashboard is
 * `null` so the page can offer a way back; any other failure is an error.
 */
export const getDashboard = createServerFn({ method: "GET" })
  .validator((input: { project: string; dashboard: string }) => {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.project !== "string" ||
      typeof input.dashboard !== "string"
    )
      throw new Error("A dashboard needs a project and a dashboard key.");
    return { project: input.project, dashboard: input.dashboard };
  })
  .handler(async ({ data }): Promise<StoredDashboard | null> => {
    if (!key.test(data.project) || !key.test(data.dashboard)) return null;
    const { serveApi } = await import("./api/serve");
    const response = await serveApi(
      new Request(
        `http://localhost/api/read/products/${encodeURIComponent(data.project)}/dashboards/${encodeURIComponent(data.dashboard)}`,
      ),
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        "Could not load this dashboard. Check that ClickHouse is running and try again.",
      );
    const dashboard = await response.json();
    if (!dashboard || typeof dashboard !== "object" || !Array.isArray(dashboard.document?.widgets))
      throw new Error("The API returned an invalid dashboard.");
    return dashboard as StoredDashboard;
  });

/** Every cached dashboard document; the open one is the active query. */
export const dashboardQueries = ["dashboard"] as const;

/**
 * The open dashboard's document, cached per project and dashboard key. Freshness comes from
 * navigation and the workspace's dashboards signal, not from time, and a failed refresh keeps the
 * last document it read.
 */
export const dashboardQuery = (project: string, dashboard: string) =>
  queryOptions({
    queryKey: [...dashboardQueries, project, dashboard] as const,
    queryFn: () => getDashboard({ data: { project, dashboard } }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: browserGcTime(30 * 60_000),
    retry: 2,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

/**
 * The route loader's document. A known one returns at once and refreshes in the background, so a
 * return visit never waits and a failed refresh never replaces the page; the first read waits, and
 * only its failure shows the route's error.
 */
export async function loadDashboard(client: QueryClient, project: string, dashboard: string) {
  const options = dashboardQuery(project, dashboard);
  const known = client.getQueryData(options.queryKey);
  if (known !== undefined) {
    void client.refetchQueries({ queryKey: options.queryKey, exact: true });
    return known;
  }
  return client.fetchQuery({ ...options, retry: false });
}
