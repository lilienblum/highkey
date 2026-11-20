# Exploring from the overview

Select a project and source in the sidebar, and a date range beside the report heading. **All sources** combines the project; a named source filters every metric, chart, breakdown, and event row on the server. Every source uses the same overview, includes all event names, and offers the same chart metrics and breakdowns. The URL records the selected project, source, and date range; saved preferences only initialize a bare entry URL. Settings manages every source regardless of the analytics selection.

Click a page, command, event, referrer, or other breakdown row to filter Overview in place. A removable filter and **View matching events** link appear above the metrics. That link opens Events with the selected source, exact UTC interval, and typed value. Overview supports one event/client/property filter plus source scope; choosing another report value replaces that filter. Source rows change the source scope and preserve the current filter. Reload and browser history restore the selection.

Page and referrer rows can also have a separate external-link icon. It appears on row hover or keyboard focus, stays visible on touch devices, and opens the website in another tab without changing the analytics filter. Page paths require the project's optional website address. Referrers must be HTTP(S) URLs or valid hostnames. Missing or unsafe targets get no external action; outgoing links suppress the referrer and opener.

Events shows the linked interval and applied filters. Use its query controls to change the measure, grouping, or filter. Running a query writes the applied configuration to the URL, so reloading or sharing it restores those changes. Unsubmitted edits stay local. Clear the drilldown to return to the normal date range. Selecting another project, source, or date range also clears the linked selection. A missing project/source or malformed drilldown shows an error instead of querying another product.

**Saved views.** The query builder stays for ad-hoc exploration. Name a query you want to keep with **Save view** in the sidebar, under Events. Views sort by name and open on the Events page with their query applied; the URL carries `view=<slug>` and the usual `query`. A view stores the event, measure, numeric property, one filter and grouping; the date range and the workspace source come from the toolbar. The open view's menu offers **Update view with current query**, **Rename**, **Copy JSON**, **Edit with your agent** and **Delete** (after confirmation). Agents list, read, save and delete views over MCP (`list_views`, `get_view`, `save_view`, `delete_view`). A view saved by an agent may use fields the page cannot show (an identity-kind filter or more than one filter); the page opens with what it can show. The former `/explore` paths redirect to `/events` with their search; the page is now called Events everywhere.

**Saved log views.** Logs has the same: **Save view** under Logs in the sidebar names the current filters and time window. A view stores the severity (an exact level or **Warn/Error/Fatal and above**), service, environment, source, message search, attribute filters and the window (15m, 1h, 6h, 24h or 7d); a trace ID, a selected range and the workspace source are not saved. Opening one applies every stored field with `view=<slug>` in the URL: the first attribute filter fills the Filters panel, further filters and a pinned source show as removable chips, and a view that names no window opens on the last hour. The open view's menu offers **Update view with current filters**, **Rename**, **Copy JSON**, **Edit with your agent** and **Delete**. A view the page cannot run says so and offers the agent guide or **Clear view**. Event and log views may share a name and slug; they are listed separately.

## Dashboards

Custom dashboards sit under **Overview** in the sidebar (and in its collapsed menu), one entry per dashboard, at `/<organization>/<project>/dashboards/<dashboard>`. They are JSON documents that an agent writes over MCP; see [custom dashboards](dashboards.md). Dashboards use the same project, source and date controls as Overview, and a widget with its own `range` ignores the date picker.

A dashboard is a 12-column grid of widget cards: stats, line, area and bar charts, rankings, event and log lists, SQL tables and text. Each card has a title (with an info hint when the widget has a description), its body, and a footer that notes the bucket and UTC, a range override, a clamped range ("Newest 31 days") and log retention ("Logs kept 7 days"). Hover the footer for how long the widget took. Widgets load as they near the viewport and refresh in the background without moving the layout; a failed one shows its error with a Retry inside its own card.

Stats and charts compare with the previous period of the same length by default, and show it beside the value: "+15% vs prior 7d" in a small tile, "+15% vs previous 7 days" in a larger one. Whether a change reads as good or bad depends on the widget's `better` (lower is better for durations), and a previous value of zero shows a dash. A widget can opt out with `compare: "none"`.

There is no manual editing. **Edit**, **New dashboard** in the sidebar, and the empty state ("No widgets yet") open the agent guide: how to connect your agent over MCP (the Claude Code command and Codex config for this address) and a copyable prompt that names the project and dashboard. Its link goes to [Ask your AI](dashboards.md#ask-your-ai) for remote setup with Access headers. The dashboard menu also offers **Duplicate**, **Copy JSON**, **Revisions** and **Delete** (after confirmation). **Revisions** lists the kept versions, newest first, with where each came from (Dashboard, MCP or API); **Restore** saves an earlier one as a new revision, so nothing is lost. The sidebar and open dashboards refresh when an agent saves.

## Shareable URLs

Projects have stable slugs, unique within their organization, and addresses that start with the organization's: an example Overview link is `/acme/orbit?source=all&period=month`. A renamed project keeps its slug. Explicit URL selections win over browser preferences; unavailable projects/sources and malformed scope parameters show an error instead of querying a fallback project. Links do not change access: someone outside the organization sees "This selection is unavailable", as for a project that does not exist.

- Project paths: `/<organization>/<project>`, `/<organization>/<project>/events`, and `/<organization>/<project>/settings`. Bare `/`, `/events`, and `/settings` open the saved project of the open organization and replace the URL with its canonical path. Older `/projects/<project>/…` links redirect when one of your organizations has that project.
- Shared query parameters: `source` (`all` or a source UUID), `days` (7, 30, or 90), `period` (`today`, `yesterday`, `month`, `last-month`, `year`, or `12months`), and optional `from` / `to` (a complete pair of exact UTC ISO timestamps, start inclusive and end exclusive).
- Overview parameters: `metric`, `breakdown`, `duration` (`avg` or `p95`), and a JSON `filter` with `field` and typed `value`. Fields are `name`, `source` (client), or `property:<name>`. Old `interval` parameters are ignored.
- Logs parameters include `view` (a saved log view's slug), `minLevel` (`warn`, `error` or `fatal`), `logSource` (a source a view pins) and `moreFilters` (attribute filters beyond the first).
- Events parameters: `view` (a saved view's slug), `query` (TanStack Router's JSON-encoded applied configuration), `page` (one-based), and `pageSize` (15, 30, or 50). Typed filter text is preserved, including the difference between `42` and `"42"`.

One date picker offers Today, Yesterday, Last 7/30/90 days, Month to date, Last month, Year to date, Last 12 months, and Custom range. A `period` takes precedence over a saved rolling `days` choice. Previous/next arrows move by day, calendar month, calendar year, or the fixed range's covered days; forward navigation stops at the current period. Rolling 7/30/90-day and 12-month windows have no arrows. Returning to the current day/month/year restores its live preset.

Custom range shows two months on desktop and one on mobile, with direct YYYY-MM-DD inputs. Pick inclusive start/end days, then **Apply range**. Cancel, Escape, and outside dismissal discard drafts. Custom ranges span at most 366 UTC days and cannot select future days. Copy the address bar to share dates and report configuration. Changing dates retains applied filters. The URL fixes the interval, not the results: late arrivals and retention can change counts. Existing `snapshot` links and exact Overview drilldown timestamps remain readable.

Project/source/date context follows sidebar navigation. Each route owns its chart or query choices; browser Back/Forward restores them. Automatic updates never rewrite the URL or add history entries, and they preserve unfinished query drafts and pagination.

## Overview widgets

Overview starts with six small square metric tiles: **Active now**, **Events**, **Visitors**, **Installations**, **Success rate**, and **Avg. duration**. They form six, three, or two columns depending on available width.

**Active now** counts distinct optional identities with events in the last five minutes. It follows the project, source, and Overview filter, independently of the historical report dates. Visitor and installation identities remain separate, even if their ID strings match. Unidentified events are never turned into people through fingerprinting. The widget shows an unavailable value when activity has no IDs or its query fails; existing live hints and visible-page refresh keep it current.

A single wide **Activity over time** chart follows. Choose events, identified actors, visitors, installations, average duration, or p95 duration. Its headline is the server's selected measure over the full period. Below it, reports form two columns on wider layouts and stack on narrow screens:

- **Breakdown** stays in the first position: ranked rows, exact counts and shares, and in-place filters. Top events is the default; longer lists scroll inside the report.
- The second position shows **Sources** when multiple sources contribute, otherwise **Identified actors**. Sources ranks the top three plus Other sources, accounting for groups beyond the server's top twelve. A single source gets no redundant comparison panel. Identities show separate visitor, installation, and other actor counts, plus sessions when supplied.
- **Success rate** reports succeeded/failed shares only among boolean `success` values. Missing properties and strings are excluded.
- **Duration** offers average/p95 summaries and a numeric comparison. Only numeric `duration_ms` values contribute. Percentiles are calculated from raw events, never averaged from bucket percentiles. There is no second duration chart.

Chart grouping is automatic in Overview and Events: ranges up to two days use hourly points; up to 31 days use daily points; up to 180 days use weekly points; longer ranges use monthly points. A note states the grouping and any partial buckets. Buckets and labels are UTC; weeks start Monday and months follow calendar boundaries. No separate interval choice is required.

Distinct identities are counted within each bucket; summing bucket counts does not give a period's distinct count. Missing durations remain gaps, not zero-duration commands. Missing measurements are explained. Changing a chart measure or breakdown only loads that region. Automatic refresh retains existing values and mounted plots; errors offer a local Retry. Skullet placeholders occupy affected regions for new scopes. The chart and Breakdown retain their positions while source discovery completes. All aggregation and filtering remain server-side; duration summaries reuse the main response.
## Breakdown dimensions

The **Breakdown** selector offers Top events, Sources, Clients, Pages, Commands, Referrers, Campaign sources, Campaigns, Screens, Versions, OS, and Architecture for every source. Property dimensions include all matching events; they do not silently restrict the event name. Missing values remain informational. Use Events to explicitly filter an event, inspect typed properties, or choose other groupings.

## Source icons

Settings lets you name sources and choose an optional icon from Hugeicons. **Automatic** follows common platform words in the name (iOS, Android, website, CLI, API, desktop, mobile, SDK, code, game); unrecognized names use a cube. Choosing an icon pins it across renames. Return to Automatic to follow the name again. Icons appear in the source list and source selector and never change analytics behavior. Integration language tabs are available for every source and remain under your control.

## Design notes

The [Datafast demo](https://datafa.st/demo) and its [filter documentation](https://datafa.st/docs/datafast-filters) informed the actionable breakdown rows and dimension choices. Highkey applies these ideas to both websites and developer tools using its existing event queries.

The [Plausible live dashboard](https://plausible.io/plausible.io) and its [dashboard tour](https://plausible.io/docs/guided-tour) informed the single period picker, calendar navigation, wide trend chart, paired reports, and separate filtering/external-link actions. Highkey adapts that structure with small square metric tiles and automatic chart grouping.

Period comparisons exist on custom dashboards (see above), where widgets run their own queries for the previous period. Overview and Events do not have them yet; they need explicit partial-day alignment and a query shape that avoids fetching unused event pages for comparison summaries.

## Event stream

The stream shows the newest events first, using event time in UTC. Website rows surface paths and referrers. Tool rows surface commands and versions, with success and duration shown when those properties have the correct boolean and numeric types. Anonymous events stay anonymous; visitor and installation identities remain distinct.

Open an event to inspect it in a side panel. Properties are searchable by name and value and include their original scalar type. Metadata shows event and receipt times, IDs, source, and optional identity/session details. The JSON tab exposes the complete event envelope. Values appear without JSON quotes and take a color by type (strings green, numbers pink, booleans and null orange), with the type in a tooltip. Copy actions still copy JSON representations, so a string such as `"42"` remains distinct from the number `42`. Code snippets in Settings and every JSON view use the same Kanagawa syntax colors.

Use a property's filter action to run a matching query. This replaces the current property filter, preserves the applied event/source/measure/grouping, and resets pagination. Unsubmitted query-builder edits are not applied by that action.

Choose 15, 30, or 50 rows per page. Filtering and pagination happen on the server. While a page loads, charts stay visible and loading rows replace the previous page. The inspector's newer/older controls move only through the loaded page. New committed data updates the table automatically without resetting the selected page or inspector.

The [PostHog Activity interface](https://posthog.com/docs/activity) informed the useful event context and separate property, metadata, and JSON views. Highkey uses its existing event model and bounded server queries.

## Zooming from charts

Drag across the Overview activity chart or an Events chart to zoom the workspace to those buckets (click one bucket to zoom to just that one). The selection becomes an ordinary custom range: the date picker shows it, the URL keeps it, and its previous/next arrows and presets work as usual. On Logs, drag across the volume histogram the same way; the time control shows **Selected range**, Follow pauses, and choosing a preset returns to a rolling window.

## Display formatting

Every displayed time uses the timezone chosen in Settings → Display, in one readable format such as `13 Nov 2026, 15:03:37.602`; UTC reads the same way. Chart buckets, calendar ranges, and raw JSON stay UTC. Reports and filter chips show well-known values with their proper names: operating systems (`macos` → macOS, `ios` → iOS), architectures (`aarch64` → ARM64, `x86_64` → x86-64), browsers, device types, and identity kinds. Unknown values appear as sent. Inspectors, raw JSON, and filters always keep the stored value.

## Logs

**Logs** opens a separate project log explorer with message search, severity/service/context filters, a volume histogram, cursor pagination, live following, and structured inspection. It shares project/source selection with analytics and has its own time window, URL filters, storage, keys, and retention. The histogram draws each bucket as a dithered aqua column with errors in solid red at its base. See [application logs](logs.md).

Service, environment, and attribute filters list the values received in the selected window, so you pick rather than type them; choosing an attribute also sets its value type. The page scrolls the stream (one scrollbar) with the column header pinned at the top; its TanStack Virtual list loads older records as you scroll and pauses Follow to preserve reading position. Older records load continuously as you near the end of the list, up to 10,000 records in the browser; at that cap the footer suggests narrowing the time range or search. The viewport supports measured mobile rows and keyboard navigation without mounting the full buffer. Back to newest resumes live results. While the search or filters differ from the displayed results, Logs shows **Changes not applied** with **Discard changes**. Settings → Logs creates source-scoped log keys, sets log retention, and has an expandable **Log setup guide** with JSON and OTLP examples for the current dashboard address.

## Loading and feedback

The project catalog loads on the server, so project pages arrive with navigation, the project picker, sources, and the page heading already in place. If the server cannot reach the API, a full-screen message offers Try again. Overview uses local placeholders inside its mounted widgets. Events uses placeholders shaped like its results, chart, breakdown, and event rows. Logs keeps its toolbar and shows a histogram placeholder and row-height placeholders. Breakdown choices load within their own card. Changing a product or query replaces the previous results with placeholders; pagination keeps the matching charts visible while its event rows load.

Refreshing the current view keeps its cards, charts, event rows, inspector, and page number visible. Analytics results are cached while you navigate: returning to Overview or Events shows the last results immediately and refreshes them in the background. Updates run in the background; a failed refresh leaves the last results available with retry feedback. New products, date selections, or applied queries still use placeholders so unrelated results are never mislabeled. Live hints, reconnection, focus, and visible online polling keep analytics current without a manual refresh control.

Run query indicates request activity and prevents duplicate submissions. Settings shows key-list loading separately from an empty list or a failed request. Create, save, and revoke actions show their active operation. A failed key revocation explains the failure inside its confirmation dialog.

A newly created key remains available to copy if refreshing the key list fails. Retrying the list does not create another key. If product creation succeeds but refreshing the product selector fails, Retry loading product fetches the catalog without submitting another creation request.

Placeholders use the fixed Kanagawa palette and respect reduced-motion preferences. Route placeholders have no minimum display duration, so a ready page is shown immediately.


## Interface icons

Highkey uses the free Stroke Rounded set from [Hugeicons](https://hugeicons.com/), rendered with `@hugeicons/react`. Import named icon data from `@hugeicons/core-free-icons` and pass it directly to `HugeiconsIcon`. Navigation, metric cards, controls, and installed shadcn primitives share this set. `apps/app/components.json` also selects `hugeicons` for future generated components.

All sources share the same analytics interface. The optional icon is visual metadata; it does not change queries or infer identity.

## Source management

Settings lists sources with their name and icon. Automatic chooses an icon from the name; an explicit choice stays fixed after renaming. Add or edit a source there, then choose it in **Key source** before creating an ingestion key. Each key belongs permanently to one source. Integration snippets use the selected source's key; Browser, TypeScript, Rust CLI, and HTTP / Mobile examples are available for every source. Renaming a source changes its display name without moving historical events. Sources share the project's retention policy and optional identity namespace. Revoke its keys to stop intake; source deletion and merging are outside v1.

## Chart inspection

Overview and Events use TanStack Charts. Hover or touch a time-series to inspect a bucket. Ranked report rows retain exact counts and shares. Keyboard users can focus the chart and use Left/Right, Home/End, and Escape; values are announced to assistive technology. Labels and tooltips use UTC regardless of the device timezone. Zero remains a measured zero, missing numeric values remain gaps, and negative numeric aggregates retain their sign. Touch scrolling remains available across the plot.

## Component foundation

Dashboard primitives use the official shadcn **Base UI** registry (`base-vega`) and `@base-ui/react`, with Hugeicons and Highkey’s Kanagawa colors and existing compact control styles. Radix is not a dependency. Add or update components from the Base UI registry, merge local styling and behavior, and use `render` composition instead of `asChild`. Buttons rendering navigation links must retain link semantics.

`ValueSelect` uses Base UI’s non-modal mode so opening a picker leaves the page scrollbar and viewport unchanged. An enclosing dialog keeps its own scroll lock. It supplies value/label items for server-rendered labels and uses a fixed popup positioner so opening a selector cannot scroll the document. Initial chart loading disables its controls until the result is ready; background refresh keeps them mounted. Dialogs, mobile navigation, tabs, and the event inspector preserve keyboard navigation and focus restoration. The sidebar continues to store its preference without cookies.

## Appearance

Highkey has one fixed Kanagawa Wave theme. Sumi-ink surfaces, warm text, orange primary actions, and yellow/violet/aqua chart accents are present from the first server-rendered paint. There is no appearance menu or theme preference, and old saved Light/Dark/Auto values are ignored.

The shared component theme defines foreground/background pairs, hover and pressed surfaces, selection, focus, radii, and elevation in `apps/app/src/styles.css`. Component variants consume those tokens directly. Buttons, button-like triggers, compact report selects, and segmented choices are pills; fields use 6px corners and a recessed surface, and cards 12px with a faint lit top edge. Translucent tints are replaced by ordered-dither screen tones (`--tone-25`, `--tone-50`, `--tone-75`) declared next to the `--tone-ink` they use. Menus use soft shadows, dialog backdrops are a sparse dot screen over a translucent dim, and keyboard focus uses a single yellow outline. Under forced colors, controls gain a system outline and selected states use the system highlight. Preserve these defaults when adding Base UI components instead of reintroducing generated dark-mode overrides or page-specific bevel styles.

## Organizations and settings

The name above the project picker is the open organization; it opens a menu of your organizations (with your role in each), **Create organization** and **Sign out**. Switching loads the other organization's address afresh.

Settings has a row of parts: **Project** (this project's sources, keys, retention and logs), **Organization** (name, address, requiring two-factor codes, transferring ownership, deleting it), **Members** (inviting with a role and a copyable link, changing roles, removing people, pending invitations), **API keys**, **Agents** (connected agents, with their access and last use, to revoke), **Account** (name, password, two-factor codes with backup codes, sessions, deleting your account) and, for the server admin, **Server** (`/admin`: everyone's accounts and organizations, banning, signing someone out everywhere, password reset links, deleting accounts). What a page offers follows your role; see [roles](access.md#organizations-and-roles).
