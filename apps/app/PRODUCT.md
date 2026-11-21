# Highkey

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and small product teams measuring websites, CLIs, and developer tools they operate. They check usage, investigate events and application logs, and manage collection. These answers are derived from the user's product brief; the user explicitly delegated the setup interview.

## Product Purpose

Provide a clear, minimal view of product usage and application behavior, self-hosted or as a hosted subscription. Success means moving from a project trend or log search to the underlying structured record without losing context.

## Positioning

Projects group named sources from websites, mobile apps, and developer tools under one typed event model and project-scoped storage. Sources have separate ingestion keys, combined or filtered analytics, and shared project retention. All sources use the same analytics UI; source icons are visual metadata only. Collection needs no website URL. Automatic visitor counting is Off by default. A source may explicitly opt into a cookieless, daily identifier, or persistent browser IDs on sites that have consent. An optional project website supplies a server-cached favicon; per-key origin restrictions filter browser ingestion without constraining native sources.

## Operating Context

Overview for regular checks, Events for server-side queries and event inspection, Logs for searching and following application logs from services, Settings for product metadata, retention, ingestion keys, and integration snippets. Retention is configured per project in Settings, with a 365-day default for new projects; existing values are preserved. The sidebar does not display retention. Persistent project/source/date selection; automatic updates through Tako ephemeral channels, with visible-tab reconciliation when notifications are missed or unavailable. No routine refresh action is required. Desktop is the main work surface; mobile supports inspection and management. Daily use by developers is an inference from the brief, not user research.

## Capabilities and Constraints

Two Tako applications: the Rust ingest app (collection only) and the TanStack Start dashboard (everything else). Events and logs in self-hosted ClickHouse; management state, accounts and organizations in a Tako-hosted SQLite database. Preserve bounded ingestion, durable acknowledgments, typed queries, and deduplication. Bun tooling only; MIT license.

## Accounts and organizations

People sign in to Highkey (email and password, optionally GitHub or Google, optional two-factor codes). Signup is open by default. After the first account sets up the server, a new account starts without an organization and can wait for an invitation or create its own. Owners and admins invite people with a role (owner, admin, member, viewer); member and viewer access can cover all projects or only selected ones. The sidebar footer menu opens personal account settings and the current organization’s settings as separate destinations. It also lets the signed-in person switch organizations. Project addresses carry the organization: `/<organization>/<project>/…`. Scripts and local pages use API keys; AI agents sign in over OAuth and are granted read only or read and write within the user's access. A self-hosted server works without email or OAuth apps: invitations are shared as links and the first account, the server admin, hands out password reset links. Sharing happens by inviting a viewer, never through public links.

One fixed Kanagawa Wave theme, Hugeicons, accessible shadcn Base UI primitives, TanStack Charts, and server-paginated tables remain. Logs support JSON and OTLP/HTTP, literal message search, typed attribute filters, and cursor pagination. Explore owns hand-built funnel, retention, conversion and breakdown analyses; agents write dashboards over MCP. A project can opt into notifications for event matches, completed visits, source or log-service health, and weekly digests. No arbitrary SQL, session replay, public sharing, or embeds.

## Brand Commitments

Project access may be restricted to selected projects for members and viewers; owners and admins oversee the organization. Project keys grant read access to one project and optionally dashboard creation and editing. Project restrictions apply to the session and its API and OAuth credentials on every request.

Highkey is the working name. The user selected Kanagawa colors and one theme without an appearance selector. Use Wave's sumi-ink surfaces and warm text, with Surimi Orange for primary actions, Carp Yellow highlights, violet/aqua chart categories, and green outcomes; avoid making the interface uniformly blue. The user requested a rebuild of the shared shadcn theme, then an ordered-dither direction modelled on tripwire.sh and dither-kit: glossy pill actions and segmented choices, inset fields, Geist Pixel page titles and measurements, 2px Bayer screen tones in place of translucent tints, dithered chart and report fills, and an animated dither field behind the sidebar identity, with restrained overlay elevation. Preserve Geist typography for interface text, the straight three-bar mark and matching favicon, flat analytical surfaces. Overview follows the user-selected Plausible-style hierarchy: small iOS-style square metrics, one wide activity chart, and paired reports. Sources use a ranked report only when multiple sources contribute; otherwise that report slot shows identified actors. Accessible shadcn Base UI primitives remain. Use straightforward product language and accurate analytics terminology.

## Evidence on Hand

Working sample website and CLI datasets; functional ingestion/query examples; automated verification in tests/ and docs/verification.md. Demo values are sample data, not customer claims. No testimonials, paying-customer claims, or new performance claims should be invented.

## Product Principles

- Minimize collection and make identity an explicit choice.
- Put product context and useful data before decorative framing.
- Give websites and tools equally capable workflows.
- Keep state stable during refresh and make pending/error states truthful.
- Prefer a small, comprehensible tool over expanding feature scope.

## Accessibility & Inclusion

Preserve keyboard access, semantic controls, visible focus, reduced-motion support, readable contrast, and narrow-screen layouts. These are implementation commitments inferred from the existing product requirements.

## Logs

Events and logs are separate signals, as in PostHog: product events feed Overview and Events; application logs from services feed Logs. Logs use a dense timestamp/severity/service/message stream, a shallow volume histogram, explicit Search for drafts, shareable applied filters, and a right-hand inspector for context, attributes, and raw JSON. Follow visible/online newest results every five seconds while keeping an inspector stable. Log keys are server secrets scoped to a project/source, separate from public analytics keys. Logs default to seven-day retention independently of event retention. App-provided log content is not automatically redacted.

The log stream uses TanStack Virtual with the page as its only scroll container and a sticky column header. It renders the viewport plus overscan, measures wrapping mobile rows, and loads older 100-record cursor batches near the bottom. TanStack Query manages page requests, cancellation, and visible/online Follow. Scrolling pauses Follow and freezes the loaded query interval. Older records load continuously as the reader nears the end of the list; there is no older-logs button. The browser keeps at most 10,000 records (only the rows in view are mounted); at that cap the footer suggests narrowing the time range or search. Loaded batches and scroll position are local to the current view. Back to newest resets the buffer and resumes Follow. Keyboard arrows, Home/End, and Page Up/Down traverse loaded records; inspector close restores a retained opener or a visible fallback. Logs identifies unapplied query drafts and offers Discard changes. On mobile, log time and severity sit above full-width, two-line messages.

## Shareable report state

Overview, Events, Logs and Settings use `/<organization>/<project>` and its `/events`, `/logs` and `/settings` routes. Older `/projects/<slug>` links redirect. Treat the project path and validated search parameters as authoritative for source, range, chart metric, Overview filter, applied Events queries and pagination, and applied Logs filters and cursors. Browser preferences only initialize bare URLs. Preserve workspace context across sidebar navigation within a project and view state through Back/Forward. Selecting another project, including a newly created one, starts with All sources and Last 7 days; clear Overview filters and chart choices, Events queries and drafts, Logs filters, drilldowns, and pagination. History navigation and direct report links must still restore their saved scope. Keep draft edits local until Run query. Calendar range selection applies explicit UTC start/end timestamps without promising immutable results; dates include whole days and the API end is exclusive. Automatic freshness must never add URL/history churn. Invalid or unavailable scope shows an error instead of silently querying another project.

## Overview reporting

Browser and OS families and versions, device type, country/region and referrer categories can be derived at insertion. Never store a visitor IP, raw user agent or city. Unknown locations stay unknown without an operator-installed network lookup. Automated traffic remains inspectable, labeled separately and excluded from ordinary reports.

The project’s Revenue report shows exact net cents grouped by source, page, profile or session, including refunds and unattributed payments. Sessions lists explicitly identified visits with selectable columns, path/referrer search, duration, page-view and bounce filters. Opening a visit shows its entry and exit, acquisition, revenue, chronological event and AI activity, and related request/trace logs. Backfills contribute activity but never establish a session boundary.

Choose the reporting period in one grouped shadcn Base UI menu with visible keycaps and a custom-range calendar; applicable previous/next arrows navigate calendar periods or fixed ranges. Chart buckets follow the range automatically. Active now counts opt-in identified actors over the last five minutes, independently of the selected reporting period, while respecting project, source, and applied filter. Visitors and installations retain distinct meanings; anonymous events still count as activity.

The small chart beside Active now shows distinct identified actors per minute over the last thirty minutes. The date menu also offers Last 30 minutes, Last hour, Last 3 months and Last 6 months. Overview, Events and dashboard charts switch to UTC minute buckets for ranges up to one hour.

Report rows filter Overview in place with one validated string, number, or boolean filter alongside source scope. View matching events opens Events with that context. An independent external-link icon appears for supported page/referrer destinations on hover or keyboard focus and remains visible on touch. Website and CLI sources remain equally supported.

Date shortcuts work on Overview and Events: D/E for today/yesterday, H for the rolling last 24 hours, W/F/N for 7/30/90 days, M/P for this/last month, Y/L for year to date/12 months, C for the calendar, and brackets for applicable previous/next periods. Ignore typing, composition, repeats, modified keys, and other open overlays. Account settings can disable these shortcuts for this browser. Ordinary menu and calendar keyboard navigation remains available.
