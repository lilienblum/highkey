---
version: 1
slug: "src-components-dashboards-dashboard-page-tsx"
primary_target: "src/components/dashboards/dashboard-page.tsx"
related_targets:
  [
    "src/components/dashboards/widget.tsx",
    "src/components/dashboards/widget-chart.tsx",
    "src/components/dashboards/agent-guide.tsx",
    "src/components/dashboards/revisions-sheet.tsx",
    "src/components/dashboards/new-dashboard-dialog.tsx",
    "src/components/dashboards/dashboards.css",
    "src/lib/dashboards.ts",
    "src/lib/growth.ts",
    "src/routes/projects.$projectSlug.dashboards.$dashboardSlug.tsx",
    "src/components/workspace-sidebar.tsx",
  ]
---

# Highkey Dashboards

Scope: viewing custom dashboards, their widget cards, revisions, and the agent guide that replaces an editor. Mode: Operate within the existing Kanagawa Wave world.
Audience: developers who ask an AI agent for a dashboard and then read it every day.
Task: open a dashboard from Overview, scan its widgets against the shared project, source and date range, see how each compares with the previous period, and hand changes to an agent.
Authority: the user chose agent-first editing. Dashboards are API-owned `highkey.dashboard/v1` documents written over MCP, so the page is for reading. There is no manual edit mode, no drag-to-arrange and no Add widget. Preserve the incumbent palette, Geist, Hugeicons and shadcn Base UI; no new visual-world selection applies.

## Direction contract

THESIS: a dashboard is Overview's evidence, arranged by someone else's request.
OWN-WORLD: Overview's widget cards (sumi-ink surface, fine seam, Geist Pixel numbers, dithered fills), the semantic data hues, and quiet footers. The page adds no chrome of its own.
STORY: pick a dashboard in the sidebar, read the grid top to bottom, notice a change against the prior period, and open Edit to ask the agent for more.
FIRST VIEWPORT: the dashboard's name and description, Edit and the overflow menu, then the 12-column grid starting with whatever the document lists first.
FORM: widget cards on a 12-column grid with 20px gaps and 140px minimum rows. Widths of 3 and 4 become 6 and 8 becomes 12 at medium widths; everything is full width when narrow. The grid keeps document order.

## Operate mode and the agent-first editing model

The header's **Edit** button and the sidebar's **New dashboard** open the agent guide dialog. An empty dashboard shows "No widgets yet" with the same guide inline. The guide shows how to connect an agent over MCP (the Claude Code command and the Codex config for the current address, each with a copy control and one polite live region for "Copied"), a note about Access headers with a link to the docs, and a copyable prompt that names the project, the dashboard and its revision, with its blanks marked, plus three example requests. A saved view has the same guide for its kind. Nothing in the guide edits a document.

The overflow menu holds **Duplicate** (asks for a name and opens the copy), **Copy JSON**, **Revisions** and **Delete** (confirms first). Failures print under the heading. Revisions opens a sheet listing kept versions newest first, each with its origin (Dashboard, MCP or API) and a **Current** badge; **Restore** asks first and saves the old version as a new revision, and a refused restore shows the API's hint. A save from an agent updates the open dashboard through the live hint (30 second polling in standalone and Compose).

## Widget card anatomy

Title, with an info icon (popover, opens on hover and focus) when the document has a description; the body for its view; a footer of notes. Stats show a Geist Pixel value with an optional sparkline and one line of growth text. Charts reuse the Overview chart language: angular lines, dithered fills, sparse axes, UTC buckets, keyboard inspection and drag-to-zoom. Rankings, SQL tables (sticky header, scrolling inside the card, a 10,000-row note) and event and log lists keep their own scroll inside a fixed card height. Text widgets render a small Markdown subset.

Colors come from the document's names (`yellow`, `violet`, `aqua`, `green`, `red`, `neutral`); there is no orange. A fourth to sixth series reuses a hue as its dither tone: a dotted line, a checkered 50% fill and a dotted legend swatch. Thresholds recolor the value and a single-series line. The footer joins its notes with a middle dot: a range override ("Last 24 hours"), a clamp ("Newest 31 days"), the bucket and "UTC", log retention ("Logs kept 7 days") and a table's row note. Hovering it shows how long the widget took.

## Growth text

Stat, line, area and bar widgets compare with the previous period of equal length unless the widget says `compare: "none"`. Small tiles read "+15% vs prior 7d" (hours up to two days: "prior 24h"); larger cards read "+15% vs previous 7 days". Rates show percentage points ("pts"). The outcome is colored green or red from the widget's `better` (lower is better for `ms` and `seconds` by default) and neutral when the change rounds to zero. A previous value of zero or none shows a dash, never an error. A grouped series has no comparison; a ranking compares totals.

## States

Widgets load when near the viewport and refresh in the background without moving the card; known values stay while refreshing and a new scope uses Skullet placeholders sized to the real content. A failed widget shows its error with Retry inside its own card, and the rest of the grid keeps working. Empty results are plain sentences ("No values in this range.", "No matching events in this range."), distinct from an unavailable result ("Chart unavailable."). A missing dashboard shows "This dashboard no longer exists" with a way back. Clamping and retention are footer notes, not errors. Keyboard focus and the reading order follow document order; every card section is labelled by its title.

Unresolved: none for this surface; drag-to-arrange, an in-page widget editor and sharing outside the signed-in user are outside the built scope.
