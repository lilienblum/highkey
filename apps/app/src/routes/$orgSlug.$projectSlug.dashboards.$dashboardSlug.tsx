import { createFileRoute } from "@tanstack/react-router";
import { DashboardError, DashboardPage } from "@/components/dashboards/dashboard-page";
import { loadDashboard } from "@/server/dashboards";
import { workspaceSearch } from "@/lib/route-search";

// The document renders on the server; each widget's data then loads on its own in the browser.
// The page reads the document from the query cache, which the workspace's live updates refresh.
export const Route = createFileRoute("/$orgSlug/$projectSlug/dashboards/$dashboardSlug")({
  ...workspaceSearch("report"),
  loader: ({ params, context }) =>
    loadDashboard(context.queryClient, params.projectSlug, params.dashboardSlug),
  component: DashboardPage,
  errorComponent: DashboardError,
});
