---

version: 1
slug: "src-components-logs-tsx"
primary_target: "src/components/logs.tsx"
related_targets: ["src/components/log-stream.tsx", "src/lib/use-log-feed.ts", "src/lib/log-buffer.ts", "src/components/log-settings.tsx", "src/components/app-shell.tsx", "src/components/workspace-sidebar.tsx", "src/lib/logs.ts", "src/logs.css", "src/routes/logs.tsx", "src/routes/projects.$projectSlug.logs.tsx"]
---

# Piko Logs

Scope: project log exploration, structured inspection, and log connection settings. Mode: Operate within the existing Kanagawa Wave world.
Audience: developers investigating service behavior. Task: choose project/source, search and filter logs, find a request, inspect typed context, and connect services.
Authority: the user requested dense, polished log investigation with a separate database per project. Preserve the incumbent palette, Geist, Hugeicons, and shadcn Base UI; no new visual-world selection applies.

## Direction contract

THESIS: compact investigation beside a dense stream.
OWN-WORLD: shared sumi-ink surfaces, warm text, orange actions, semantic severity accents, inset fields, and fine seams.
STORY: search a project, locate a request, then inspect structured context without losing the stream.
FIRST VIEWPORT: search/time/follow controls, compact severity/service choices, a shallow volume histogram, and aligned time/severity/service/message rows.
FORM: user-specified stream and right-hand inspector extending the existing shell; no concept roll or new identity.

## Built composition and behavior

Logs uses the shell's shared `PageHeader` as a direct content-grid child. Heading position, typography, responsive gutters, and header spacing match Overview, Explore, and Settings; stream density begins below that common frame.

The search field owns remaining query-bar width; the time selector has a bounded width and Follow stays alongside it. Advanced context filters expand below compact severity/service choices. The volume plot is a shallow aqua field with red error volume. Records use 35px minimum rows, fine seams, tabular times, short severity labels, muted service names, and literal monospace messages. These sizes are local stream geometry, not shared control tokens.

At 900px and below, query controls form a two-column grid and record columns tighten. At 600px and below, 60px-minimum rows place 11px time and severity above a full-width 12px message, wrapping to two lines; service remains in inspection. The Sheet inspector is at most 620px and never wider than the viewport. Context pairs, Attributes/Raw JSON tabs, quoted strings, numeric/boolean literals, copy feedback, and scalar filter actions retain the original data types.

Applied filters live in the URL; message drafts wait for Search and show an unapplied-state notice with Discard changes. Cursor pages freeze their window. Following checks newest results every five seconds while visible and online without replacing an open inspector. Initial loading has row-shaped placeholders. Empty results, context-only unmatched searches, invalid queries, and failed requests remain distinct; background refresh retains known results. Read-only queries retry one short server-advertised capacity delay before showing actionable busy feedback.

The stream uses TanStack Virtual's window virtualizer (the page is the only scroll container) with stable log IDs, measured row heights, eight overscan rows, a sticky column header, and a roving tab stop. Up/Down, Home/End and Page Up/Down navigate the loaded records. Focused and inspected rows stay mounted while available; an aged-out opener returns focus to a visible row. The viewport has a bounded responsive height shared by loading and empty states, with the column header and footer outside it. Scrolling pauses Follow and loads older records near the bottom using the last successful query interval. The local buffer is capped at 10,000 records; only nearby rows are mounted. There is no load-more control; at the cap the footer suggests narrowing the range or search. Back to newest resets the buffer and resumes live results. Local appends do not rewrite history. An older-page error retains existing rows and requires a retry; a scope change aborts pending work.

TanStack Query's infinite query manages those requests in a Logs-local client. Keys contain the project and API filter/range parameters, independent of unrelated URL defaults. Inactive pages are discarded immediately. Query handles visible/online polling and scoped cancellation; paused views disable automatic refetches, and resuming Follow trims to the first page before refreshing. Background failures retain the last successful rows and time bounds. The request helper keeps its single advertised capacity retry without additional Query retries.

Settings keeps log retention and source-scoped log keys separate from analytics. Full keys appear once, then only metadata remains. No credentials or raw log data enter ephemeral analytics notifications.
Connect a source lands directly at Settings' Logs section. A visible source field labels key scope, and an expandable guide provides current-origin JSON and OTLP examples using a server environment variable for the key.
Unresolved: none for this surface; saved searches, alerts, and arbitrary SQL remain outside the built scope.
