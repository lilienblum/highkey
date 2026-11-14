import { createFileRoute } from "@tanstack/react-router";
import { DashboardError, DashboardPage } from "@/components/dashboards/dashboard-page";
import { getDashboard } from "@/server/dashboards";

// The document renders on the server; each widget's data then loads on its own in the browser.
// A dashboard changed elsewhere invalidates this match from the workspace's live updates.
export const Route = createFileRoute("/projects/$projectSlug/dashboards/$dashboardSlug")({
  loader: ({ params }) =>
    getDashboard({ data: { project: params.projectSlug, dashboard: params.dashboardSlug } }),
  component: DashboardPage,
  errorComponent: DashboardError,
});
