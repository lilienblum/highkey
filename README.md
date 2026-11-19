# Piko

Privacy-first, self-hosted product analytics and application logs for websites, CLIs, and developer tools. MIT licensed.

Piko runs two independent applications on a self-hosted ClickHouse server:

- **`apps/ingest`** — Rust/Axum/Tokio, package `piko-ingest`. It only receives events and logs (`/api/ingest`, `/api/logs/ingest`, `/api/logs/v1/logs`) and serves the browser tracker at `/tracker.js`. It checks each key against ClickHouse's key registry, writes to ClickHouse, and acknowledges only after ClickHouse has stored the rows. It holds no state of its own and knows nothing about the dashboard.
- **`apps/dashboard`** — React/TypeScript with **TanStack Start**, Vite, shadcn/ui on Base UI, [TanStack Charts](https://tanstack.com/charts/latest), and TanStack Table. Runs on **Bun** and serves the UI and every other path: projects, sources, keys, queries, dashboards, saved views, MCP and live hints. It keeps that management state in SQLite (`state.sqlite`), owns the ClickHouse schema (`clickhouse/migrations`), and mirrors keys and retention into ClickHouse. Authentication is handled by Cloudflare Access, outside the app.
- **ClickHouse** — one node, never public. It stores events and logs with TTL retention. Each project reads its data as its own ClickHouse user, through views that hold only its rows.

```
 SDKs, tracker, OTLP ─▶ /api/ingest, /api/logs/*, /tracker.js ─▶ ingest (Rust, stateless) ───┐
                                                                   │ change hints            │
                                                                   ▼                         │
 Browsers, agents ─────▶ everything else ──────────────────────▶ dashboard (Bun, SQLite) ────┤
                                                                                             ▼
                                                                                   ClickHouse (one node)
```

When the edge routes the ingest paths to the ingest app, ingestion never passes through the dashboard: a dashboard deploy leaves it running, and ClickHouse gives it priority over dashboard queries. When the edge cannot route them separately, the dashboard forwards them to the ingest app.

## Develop locally with Tako

Requires [Tako](https://tako.sh/) `0.0.0-9ae824f` or a later release with ephemeral channels, Bun 1.4+, a current stable Rust toolchain (tested with 1.95.0), a C compiler, and Docker for the local ClickHouse. No npm or Node runtime is required.

```sh
git clone git@github.com:lilienblum/piko.git
cd piko
bun install --frozen-lockfile
bun dev
```

Open **https://piko.test**. The ingest app runs at **https://piko-ingest.test**. `bun dev` starts a local ClickHouse in Docker (`bun scripts/clickhouse.ts dev-up`: port 8123 on 127.0.0.1, data in the `piko-dev-clickhouse` volume) and migrates it, builds the browser tracker, then starts both apps through Tako (`tako.ingest.toml` and `tako.dashboard.toml`). It also creates a shared development notification secret if absent, encrypted by Tako under the ignored `.tako/` directory. There is no application login. `bun run dev:stop` stops the two apps; ClickHouse keeps running until `bun scripts/clickhouse.ts dev-down`.

```sh
SSL_CERT_FILE=.tako/dev-ca.pem PIKO_API_URL=https://piko.test bun seed
```

This creates one **Orbit** project with **Website**, **iOS app**, and **CLI** sources, with 30 days of sample page views, signups, mobile screens/subscriptions, commands, and configuration events. Earlier demo projects remain untouched. `bun seed` targets `http://127.0.0.1:3000` when `PIKO_API_URL` is unset. Overview and Events update automatically through ephemeral Tako channels after events are stored. Returning to the tab or reconnecting catches up; a 30-second check covers missed hints and standalone mode. Draft queries, the selected page, and open event inspection stay intact. Stable event IDs keep a rerun over the same UTC dates from adding events: within 24 hours the repeats count as duplicates, and later copies are removed by background merges. Each run creates a fresh sample ingestion key. Sample data is opt-in and never loaded in production automatically.

`bun run dev:standalone` runs the same stack without Tako: the ingest app at http://127.0.0.1:3001 and the dashboard at http://127.0.0.1:3000, refreshing by polling.

See [Tako setup, deployment, and realtime delivery](docs/tako.md). Development uses Tako's trusted local HTTPS proxy. If the CLI reports missing host prerequisites, complete `tako doctor` / Tako's local setup first.

## Deployment

Piko deploys as two native Tako apps, `tako.ingest.toml` and `tako.dashboard.toml`, on a ClickHouse server you install on the host with Piko's settings files. See [Tako setup and deployment](docs/tako.md) for installing ClickHouse, deploying, updating and backing up. The two apps take separate production hostnames, so the ingest paths never pass through the dashboard, and they share a notification secret for immediate ephemeral channel hints (with polling recovery); ephemeral channels require one Tako server without a shared Postgres credential.

There is no migration from the earlier DuckDB-based versions: start a new deployment and create projects and keys there. Protect all management access using Cloudflare Tunnel and Access before exposing either app. See [the access boundary](docs/access.md). Piko does not validate Access JWTs or provide fallback authentication.

Without Tako, build with `bun run build` and `cargo build --locked --release -p piko-ingest`, migrate your ClickHouse with `bun run migrate`, then run `./target/release/piko-ingest` and `bun run --cwd apps/dashboard start` in separate terminals, with the settings below. The ingest app listens at http://127.0.0.1:3001 and the dashboard at http://127.0.0.1:3000.

The dashboard keeps `state.sqlite` (with its WAL files) in `PIKO_DATA_DIR`: `$TAKO_DATA_DIR` under native Tako (locally `.tako/data/app`), and `./data` by default. Run exactly one dashboard process per data directory, on durable local storage, never a network filesystem. Events and logs live in ClickHouse. Back up both: ClickHouse with `BACKUP DATABASE piko`, and `state.sqlite` with `VACUUM INTO`; see [backups and restore](docs/tako.md#backups-and-restore). Retention is ClickHouse TTL: expired rows are deleted during background merges, so disk use need not shrink immediately. Run one ingest process, because exact deduplication relies on it.

Ingest app settings:

| Setting                           | Default                    | Purpose                                                                                     |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `PIKO_CLICKHOUSE_URL`             | `http://127.0.0.1:8123`    | ClickHouse's HTTP interface                                                                 |
| `PIKO_CLICKHOUSE_USER`            | `piko_ingest`              | The user `bun run migrate` creates for the ingest app                                       |
| `PIKO_INGEST_CLICKHOUSE_PASSWORD` | empty                      | That user's password (a Tako secret under native Tako); `PIKO_CLICKHOUSE_PASSWORD` if unset |
| `PIKO_BIND`                       | `127.0.0.1:3001`           | Standalone listener; Tako owns its listener                                                 |
| `PIKO_QUEUE_CAPACITY`             | `64` (1–1024)              | Bounded event upload slots and write queue                                                  |
| `PIKO_TRACKER_PATH`               | unset (`/tracker.js` 404s) | The built tracker bundle, `sdk/typescript/dist/tracker.js`                                  |
| `PIKO_CHANGE_URL`                 | unset outside Tako configs | Optional post-commit notification endpoint, `/_piko/changes`                                |
| `PIKO_CHANGE_TOKEN`               | Tako secret                | Shared ingest-to-dashboard credential; never sent to browsers                               |

Dashboard settings:

| Setting                           | Default                   | Purpose                                                                                        |
| --------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `PIKO_CLICKHOUSE_URL`             | `http://127.0.0.1:8123`   | ClickHouse's HTTP interface                                                                    |
| `PIKO_CLICKHOUSE_USER`            | `piko_admin`              | Admin user for migrations, access control and the key registry                                 |
| `PIKO_CLICKHOUSE_PASSWORD`        | empty                     | The admin password                                                                             |
| `PIKO_READER_SECRET`              | the admin password        | Derives each project's ClickHouse reader password                                              |
| `PIKO_INGEST_CLICKHOUSE_PASSWORD` | none                      | `bun run migrate` only: the password it gives `piko_ingest`                                    |
| `PIKO_INGEST_URL`                 | `http://127.0.0.1:3001`   | Where the dashboard forwards the ingest paths and `/tracker.js`                                |
| `PIKO_DATA_DIR`                   | `TAKO_DATA_DIR` or `data` | Directory of `state.sqlite`                                                                    |
| `PIKO_QUERY_CONCURRENCY`          | `4` (1–16)                | Dashboard widget runs: event widgets share one fewer slot than this, log widgets one           |
| `PIKO_CORS_ORIGINS`               | unset (loopback only)     | Extra origins allowed to read `/api/read/*`; see [local pages](docs/dashboards.md#local-pages) |
| `HOST`, `PORT`                    | `127.0.0.1`, `3000`       | Standalone Bun dashboard listener                                                              |

## Use it

1. **Settings:** create a project, then add named **sources** such as Website, iOS app, or CLI. All sources use the same analytics UI. Icons follow the source name automatically, or can be chosen from a predefined Hugeicons set; no URL is needed. Create a key for a specific source and copy it while visible. Only its SHA-256 hash and display prefix are stored.
2. **Overview:** select a project, source (or **All sources**), and date range. Every source has the same widgets and query choices; Overview includes all event names. A combined project shares storage and retention. Missing identity or duration is shown honestly as unavailable.
3. **Events:** select an event, measure, grouping, and optional typed property filter. Counts, distinct actors, numeric sum/average/min/max, and p50/p95 run in ClickHouse. Charts, grouping, filtering, and event pagination are server-side. Click an event for its original typed envelope.
4. **Logs:** search messages, filter by severity, service, and context, inspect structured records, and follow live logs. Services send structured JSON or OTLP/HTTP with separate `pl_` log keys created in Settings → Logs. Logs live in ClickHouse apart from events, with an independent seven-day default retention. See [application logs](docs/logs.md).

There is no built-in login, admin token, password, or admin session cookie. Management mutations use an `X-Piko-Admin: 1` request marker to prevent cross-site form submissions; it is not a secret or authorization mechanism. Cloudflare Access is the authentication boundary.

Click an Overview breakdown row to filter the dashboard in place; **View matching events** opens the filtered event stream. Page and referrer rows offer a separate external-link action on hover or keyboard focus. See [the dashboard guide](docs/dashboard.md) for drilldowns, typed filters, and date behavior.

Project, source, range, chart choices, applied Events queries, and Logs filters live in the URL. For example, `/projects/orbit?source=all&period=month`. One date picker provides presets, custom calendar dates, and previous/next navigation for calendar periods and fixed ranges. Custom dates use inclusive UTC days as explicit `from` / `to` timestamps (the API end is exclusive); they do not archive results. Chart grouping adjusts automatically to the chosen range. Reload, sharing, and browser history restore the view.

## Dashboards and MCP

Dashboards are JSON documents that the dashboard app stores, written over MCP by the AI agent you already use (Claude Code, Codex or anything that speaks MCP). Each widget runs typed event and log queries, funnels and retention, combined with formulas; documents hold no SQL. Every save is validated and timed, and revisions let you undo. Dashboards appear under Overview in the sidebar, and named queries can be saved as views under Events and Logs.

```sh
claude mcp add --transport http piko http://127.0.0.1:3000/mcp
```

Remote setups, the Codex config, the document reference, worked examples and the read-only `/api/read` surface for your own local pages are in [custom dashboards, views and MCP](docs/dashboards.md). Give an agent only the read-only token if it should not change anything; see [access](docs/access.md#mcp-and-read-only-access) and [privacy](docs/privacy.md#ai-agents-and-mcp). Errors and endpoints are in the [API reference](docs/api.md#dashboards-views-and-mcp).

See [API and data semantics](docs/api.md), [collection examples and identity](docs/collection.md), and [the privacy model](docs/privacy.md).

### SDKs

- [JavaScript / TypeScript — `@piko/sdk`](sdk/typescript/README.md): zero runtime dependencies, ESM and TypeScript declarations, explicit sends and a privacy-aware browser tracker.
- [Rust — `piko-sdk`](sdk/rust/README.md): standalone async collection using reqwest/rustls, Tokio, serde/serde_json, uuid, and chrono. It does not pull in Piko's apps or databases. Its examples include a CLI that reports each command (`cargo run -p piko-sdk --example cli -- build`).

Both support typed properties, batches, stable event IDs across bounded retries, and persistence acknowledgments. Packages are available from this checkout; they have not been published to registries. The linked guides cover local installation and examples. The HTTP paths still use `/products` for existing integrations.

## Privacy defaults

Collection starts without visitor, session, or installation identifiers. The browser tracker honors DNT/GPC, leaves campaign capture off until explicitly configured, and offers pre-send filtering plus an opt-out that discards queued data. The CLI example requires an explicit opt-in. New projects created in Settings start with one-year retention (365 days). Retention is configurable per project in Settings; existing projects keep their configured value.

Piko does not derive analytics identity from IP addresses or user-agent information. Paths, custom properties, and optional persistent IDs are still data you choose to collect; they are not automatically anonymized. ClickHouse is the isolation boundary between projects, so keep it upgraded. Read [the privacy model and collection controls](docs/privacy.md) before integrating private application routes.

## Checks

```sh
bun run fmt
bun fmt:check
bun typecheck
bun lint
bun scripts/clickhouse.ts test-up
bun run test
bun run build
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Use `bun run fmt`: bare `bun fmt` runs Bun's built-in formatter and reformats unrelated files. Likewise `bun run test` runs the SDK, script and dashboard server tests, while bare `bun test` scans only `sdk/` (the test root in `bunfig.toml`). The dashboard and Rust tests run against a disposable ClickHouse in Docker (`piko-test-clickhouse`, in memory, on 127.0.0.1:18123); they start it themselves if it is not running, `bun scripts/clickhouse.ts test-up` starts it ahead of time, and `test-down` removes it. `cargo test` needs Bun and Docker for the same reason.

`bun run test:e2e` starts a dedicated ClickHouse (on 127.0.0.1:18124) and two dedicated Tako apps at `https://piko-e2e.test` and `https://piko-e2e-ingest.test`, runs real Chromium tests, then stops those apps and deletes their temporary data. Initialize local TLS and the notification secret once with `bun dev`; the preview need not be running during tests. No seed is needed. To run a subset, use `bun run test:e2e tests/analytics-chart.spec.ts`.

Every run gets fresh storage under `.tako/e2e/<run-id>/`. Test URLs are set by the runner, existing URL overrides cannot point it at the preview, and direct Playwright runs are rejected. A preflight requires an empty test database before any fixtures are created. Test failure, Ctrl-C, and SIGTERM all run teardown. A lock prevents simultaneous runs from sharing the test hosts. If a process is force-killed, follow the [test recovery instructions](docs/tako.md#browser-tests); its data remains separate from the preview. If Chromium is absent, install it with `bun node_modules/@playwright/test/cli.js install chromium`.

```sh
bun run test:load
```

The load test checks that ingestion stays fast while dashboards run heavy queries. It starts its own ClickHouse (4 GB, in memory) and the release ingest binary, preloads 10 million events, and runs 30 seconds of ingestion alone, then 30 seconds with heavy dashboard reads. It fails if any ingest request fails, or if the loaded acknowledgment p99 is more than twice the unloaded one or reaches 250 ms. It never touches your running workspace. `bun benchmark` and `bun benchmark:logs` measure mixed ingestion and query throughput the same way, on a ClickHouse of their own; see [the benchmark report](docs/benchmark.md) for measured results and their limits.

See [the verification record](docs/verification.md) for measured checks and their limits.

## Scope and limitations

- External access control, one ClickHouse node, one ingest process, one dashboard process. Tako updates both apps with a rolling replacement; for a few seconds the old and new dashboard share `state.sqlite`, and SQLite's locking serializes their writes. One ClickHouse node shares CPU and disk between ingestion and queries; per-project caps and ingest priority bound the interference without removing it. No replication, multi-user permissions, or automatic backups yet.
- Browser ingestion keys are intentionally public and write-only. They are not anti-abuse credentials; a key holder can submit fabricated events. There is global capacity backpressure, but no per-key fairness or bot detection.
- Identity is explicit, optional, and project-scoped. There is no IP/user-agent fingerprinting. The browser tracker defaults to unidentified events and always honors Do Not Track and Global Privacy Control. Installations are distinct from website visitors and sessions.
- Settings → Display controls the event timezone for this browser, including event inspection. Stored timestamps, JSON exports, chart buckets, and date-range boundaries remain UTC. Date ranges are half-open; today is partial. Local-time/DST aggregation is not supported yet.
- Pagination is bounded offset pagination, ordered by time and event ID. Different pages may shift when new events arrive. Top breakdowns are limited to 12 groups, event-name discovery to 100 names, filters to 8, pages to 10,001, and page size to 100.
- Delivery from browsers/CLIs is best effort with bounded retries. A flush confirms attempted delivery, not guaranteed delivery. Deduplication is exact for 24 hours and eventual after that; see [deduplication](docs/api.md#deduplication) for the two cases where a duplicate can last.
- No session replay, alerts, or distributed storage. Custom dashboards are written by an agent or by script, not dragged together in the UI, and their queries are Piko's typed entities, including funnels and retention, with no SQL.

[Liwan](https://github.com/explodingcamera/liwan) informed Piko's early embedded-storage design. Piko has its own implementation and product model, with equal support for websites and tools.

### Dashboard appearance

Piko uses one fixed [Kanagawa Wave palette](https://github.com/rebelot/kanagawa.nvim): sumi-ink surfaces, warm text, orange actions, and yellow/violet/aqua chart accents. There is no theme selector. The same appearance is rendered before JavaScript loads, regardless of system settings or old saved theme preferences.

The compact workspace sidebar holds the project selector, page navigation, and a visible source list. Select All sources for the combined view or a named source to filter the project. The date control sits below the report heading within the content layout. Settings omits report-only controls. Overview and Events update automatically while preserving the current layout and query drafts; Logs follows new records every five seconds while Follow is on. The sidebar collapses to icons on desktop and opens as a drawer on mobile, where project selection remains in the compact report controls.

Overview starts with six small square metric widgets, including **Active now** for optional identities seen in the last five minutes. One wide activity chart follows, then paired ranked reports. Source comparison appears only when multiple sources contribute. One date control selects the reporting period; hourly/daily/weekly/monthly grouping is automatic, with UTC weeks beginning Monday. There are no manual interval controls. Partial buckets are labelled, and loading or automatic refresh keeps the layout in place. Dashboard controls use shadcn/ui's Base UI DropdownMenu, Select, Calendar/Popover, Sidebar/Sheet, ToggleGroup, Collapsible, Tabs, Switch, and AlertDialog alongside its buttons, forms, cards, and tables.

The visual system pairs Kanagawa colors with locally served Geist, Geist Mono, and Geist Pixel ([Geist license](apps/dashboard/public/licenses/geist.txt), [Geist Mono license](apps/dashboard/public/licenses/geist-mono.txt), [Geist Pixel license](apps/dashboard/public/licenses/geist-pixel.txt)). Geist Mono sets code and identifiers; page titles and measurements use Geist Pixel. The shared shadcn theme uses glossy pill actions and segmented choices, inset fields, and soft menu/dialog shadows. Wherever the interface would use a translucent tint, it uses an ordered-dither (2px Bayer) screen tone instead: chart and report fills, active navigation, button states, and dialog backdrops. A dither field behind the sidebar logo drifts on arrival and on hover, then holds still; it never moves under reduced motion. Orange primary actions and the matching three-bar logo/favicon anchor the interface. Analytical sections stay nearly flat; forms and inspectors retain clear boundaries. [Product context](apps/dashboard/PRODUCT.md) and [design rules](apps/dashboard/DESIGN.md) record the current decisions.

Loading regions use the official [Skullet](https://skullet.lochie.me/) package: measured text placeholders and shared skeleton boxes for charts, tables, and keys. The navigation and report controls stay mounted; existing results remain visible during refresh. Reduced motion disables skeleton animation.

Charts use [TanStack Charts](https://tanstack.com/charts/latest) with Piko’s theme and UTC labels. Mouse, touch, and arrow keys inspect values; missing numeric values remain gaps. See the [chart integration notes](docs/charts.md).

Website ingestion keys can optionally restrict allowed origins in Settings, including `https://*.example.com` subdomains. Add the apex separately; schemes and ports match exactly. Restricted keys reject missing or unmatched Origin headers before writing events. Keep separate unrestricted keys for CLI/mobile/server clients. These checks reduce browser misuse, but public keys and forgeable non-browser headers cannot authenticate a sender. See [origin policy details](docs/api.md#optional-browser-origin-restrictions).

Projects can optionally have a website address. Piko fetches its favicon on the server, caches it locally, and uses it in the project selector. No external icon service receives dashboard requests. Standard raster favicon paths are supported; unavailable or unsupported images fall back to the project icon. Website metadata and ingestion restrictions are separate, so adding a website never breaks CLI or mobile collection.

The date menu groups working periods and shows their keyboard shortcuts: **D** today, **E** yesterday, **H** last 24 hours, **W/F/N** last 7/30/90 days, **M/P** month to date/last month, **Y/L** year to date/last 12 months, and **C** custom range. **[** and **]** navigate applicable previous/next periods. These shortcuts work in Overview and Events, ignore typing and other open overlays, and can be disabled in **Settings → Display → Date keyboard shortcuts**. Arrow keys, Enter, Tab, and Escape continue to work with shortcuts disabled.
