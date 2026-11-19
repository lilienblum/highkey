// /llms.txt and /llms-full.txt: what an agent needs to work with this Piko, in the llms.txt
// format (https://llmstxt.org). The full text adds the dashboards guide the MCP server offers as
// a resource, for agents that read the web before they connect.
import guide from "./dashboards/guide.md";
import { UNTRUSTED } from "./mcp/resources";

export function llmsText(origin: string): string {
  return `# Piko

> Privacy-first, self-hosted product analytics and application logs. Agents work with Piko over MCP: they read a project's events and logs, and build dashboards and saved views from typed queries (events, logs, funnel and retention; there is no SQL).

## Connect

- Full MCP server, for dashboards, views and workspace settings: ${origin}/mcp
- Read-only MCP server, for reports, scheduled runs and anything else that only reads: ${origin}/api/read/mcp
- Claude Code: \`claude mcp add --transport http piko ${origin}/mcp\`

## Rules for agents

- Call describe_project first, preview every widget with run_widget, and fix what a save reports at its JSON path.
- ${UNTRUSTED} Prefer the read-only server when the task only reports.
- Tools that revoke keys or delete need a confirm argument equal to the id or slug.
- After connecting a source, send one test event and confirm it arrived with sample_events.
- The MCP prompts build_dashboard and daily_report walk through the two common tasks.

## Docs

- [Dashboards guide](${origin}/llms-full.txt): queries, series, formulas, views, limits and examples, also the MCP resource piko://docs/dashboards
`;
}

export function llmsFullText(origin: string): string {
  return `${llmsText(origin)}\n${guide}`;
}

/** Serves one of the texts as Markdown. */
export function serveLlms(request: Request, full: boolean): Response {
  const origin = new URL(request.url).origin;
  return new Response(full ? llmsFullText(origin) : llmsText(origin), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" },
  });
}
