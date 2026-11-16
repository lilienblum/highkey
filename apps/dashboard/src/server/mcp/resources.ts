// The MCP resources (the dashboard JSON Schema and the agent guide) and the build_dashboard prompt.
import schema from "../dashboards/dashboard.v1.schema.json";
import guide from "../dashboards/guide.md";

export const SCHEMA_URI = "piko://schema/dashboard.v1";
export const GUIDE_URI = "piko://docs/dashboards";

/** A resource's text and type, or null for an unknown URI. */
export function readResource(uri: string): { text: string; mimeType: string } | null {
  if (uri === SCHEMA_URI) return { text: JSON.stringify(schema), mimeType: "application/json" };
  if (uri === GUIDE_URI) return { text: guide, mimeType: "text/markdown" };
  return null;
}

export function buildDashboardPrompt(goal: string): string {
  return `Build a Piko dashboard for this goal: ${goal}

1. Call describe_project to see the project's event names, properties, log services and limits. Read the piko://docs/dashboards resource if you have not.
2. Draft the widgets: typed queries with formulas, funnels for step-by-step conversion and retention for cohorts. Call run_widget for each one and look at the series or rows; use sample_events or sample_logs if a name or property is unclear. Fix anything that comes back empty, with a warning or too slow.
3. Assemble the document and call validate_dashboard. Fix every error at its JSON path.
4. Call save_dashboard. If it returns errors, fix them and save again. Tell the user the dashboard's slug and that it appears under Overview in Piko's sidebar.`;
}
