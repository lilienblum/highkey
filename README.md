# Piko

Privacy-first, self-hosted product analytics and application logs for websites, CLIs, and developer tools. MIT licensed.

Piko has two independent applications, deployed together:

- **`apps/api`** — Rust/Axum/Tokio. Owns products, ingestion keys, ingestion, and queries. SQLite stores the shared catalog; each product gets its own DuckDB event database. It has no dependency on dashboard code, routes, or assets.
- **`apps/dashboard`** — React/TypeScript with **TanStack Start**, Vite, shadcn/ui on Base UI, [TanStack Charts](https://tanstack.com/charts/latest), and TanStack Table. Runs on **Bun**, serves the UI, and forwards `/api/*` to the Rust service. Authentication is handled by Cloudflare Access, outside the app.

This two-process layout supersedes the original single-process concept. There is still one deployment, one persistent data volume, and no external database. You can run the API on its own.

## Run with Docker Compose

Requires Docker with the Compose plugin. From this checkout:

```sh
docker compose up --build -d
```

Open **http://127.0.0.1:3000**. Both applications build inside Linux containers; no local Bun, Rust, or Tako installation is needed. Stop with `docker compose down`, which retains your data. See the [Compose guide](docs/compose.md) for updates, backups, and optional Tako hosting.

## Develop locally with Tako

Requires [Tako](https://tako.sh/) `0.0.0-9ae824f` or a later release with ephemeral channels, Bun 1.4+, a current stable Rust toolchain (tested with 1.95.0), a C++17 compiler, and local disk. DuckDB is compiled into the API; the first build takes several minutes. No npm or Node runtime is required.

```sh
git clone git@github.com:lilienblum/piko.git
cd piko
bun install --frozen-lockfile
bun dev
```

Open **https://piko.test**. The independent API runs at **https://piko-api.test**. `bun dev` starts both named apps through Tako and creates a shared development notification secret if absent. The secret is encrypted by Tako under the ignored `.tako/` directory. There is no application login. `bun run dev:stop` stops these two apps.

```sh
SSL_CERT_FILE=.tako/dev-ca.pem PIKO_API_URL=https://piko-api.test bun seed
```

This creates one **Orbit** project with **Website**, **iOS app**, and **CLI** sources, with 30 days of sample page views, signups, mobile screens/subscriptions, commands, and configuration events. Earlier demo projects remain untouched. Overview and Events update automatically through ephemeral Tako channels after events commit. Returning to the tab or reconnecting catches up; a 30-second check covers missed hints and standalone mode. Draft queries, the selected page, and open event inspection stay intact. Stable event IDs make seeding the same UTC dates idempotent; each run creates a fresh sample ingestion key. Sample data is opt-in and never loaded in production automatically.

See [Tako setup, deployment, and realtime delivery](docs/tako.md). Development uses Tako's trusted local HTTPS proxy. If the CLI reports missing host prerequisites, complete `tako doctor` / Tako's local setup first.

## Deployment

Choose either native Tako or Docker Compose. Both run the same independent Rust API and Bun dashboard with one API data directory and external access control.

| Option                                                    | Configuration                           | Automatic updates                                                 | API storage and releases                                         |
| --------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Docker Compose](docs/compose.md#run-with-docker-compose) | `compose.yaml`                          | Visible/online polling every 30 seconds, plus focus and reconnect | Named volume at `/data`; one API container                       |
| [Native Tako](docs/tako.md)                               | `tako.api.toml` + `tako.dashboard.toml` | Immediate ephemeral channel hints, with polling recovery          | `$TAKO_DATA_DIR`; gate ingress and stop the API before updates   |
| [Tako-managed Compose](docs/compose.md#deploy-with-tako)  | `tako.compose.toml` + `compose.yaml`    | Visible/online polling every 30 seconds, plus focus and reconnect | Named volume at `/data`; one API replica with stop-first updates |

Native Tako uses separate production hostnames and a shared notification secret. Ephemeral channels require one Tako server without a shared Postgres credential. Compose exposes only the dashboard, with the API private on the container network. Tako-managed Compose adds Tako's HTTPS routing, service updates, status, logs, and application rollback. See the guides for prerequisites, deployment, updates, and backups.

Docker builds separate targets from [Dockerfile](Dockerfile). Compose does not publish the API port. Stop it with `docker compose down` (without `--volumes`). Each mode has separate data; changing deployment mode does not migrate it. Protect all management access using Cloudflare Tunnel and Access before exposing either app. See [the access boundary](docs/access.md). Piko does not validate Access JWTs or provide fallback authentication.

Without Tako or Docker, use `bun run dev:standalone`, or build with `bun run build` and `cargo build --locked --release -p piko`, then run `./target/release/piko` and `bun run --cwd apps/dashboard start` in separate terminals. The standalone API listens at http://127.0.0.1:3001 and the dashboard at http://127.0.0.1:3000.

Under native Tako, data lives in `$TAKO_DATA_DIR` (locally `.tako/data/app`); Compose uses the `piko-data` named volume at `/data`; standalone binaries use `./data` by default (`state.sqlite`, SQLite WAL files, and `products/<product-id>.duckdb` with their WAL files). Application logs live beside them in `logs/<project-id>.duckdb` with their WAL files; include both directories in backups. Mount `PIKO_DATA_DIR` on durable local storage. Run exactly **one API process per data directory**. Stop the API before copying the entire directory for backup; restore the whole directory together. Tako app-data backups do not include Compose named volumes; see [Compose backups and migration](docs/compose.md#backups-and-migration). Do not share the files over a network filesystem. Cleanup logically deletes rows; disk files need not shrink immediately. An eight-instance LRU cache bounds open product databases; active connections pin their instance against eviction. Each instance has a 64 MB DuckDB buffer limit and spills at most 1 GiB to disk. Query concurrency is bounded globally. Logs have a separate four-instance cache with 32 MB buffers, two query slots, and their own bounded writer and admission. Early shared-database MVP data is imported idempotently at startup; the original `events.duckdb` remains as a backup, outside active retention, and can be removed after verifying the import.

| Setting                  | Default                    | Purpose                                                                                                   |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PIKO_DATA_DIR`          | `TAKO_DATA_DIR` or `data`  | Explicit durable database override                                                                        |
| `PIKO_BIND`              | `127.0.0.1:3001`           | Standalone API address; Tako owns its listener                                                            |
| `PIKO_QUERY_CONCURRENCY` | `4` (1–16)                 | Independent DuckDB query connections                                                                      |
| `PIKO_QUEUE_CAPACITY`    | `64` (1–1024)              | Bounded ingestion request slots/queue                                                                     |
| `PIKO_MEMORY_LIMIT`      | unset (no ceiling)         | Opt-in Linux memory ceiling: `auto` or a size such as `2G` ([resource model](docs/api.md#resource-model)) |
| `PIKO_API_URL`           | `http://127.0.0.1:3001`    | Dashboard-to-API origin                                                                                   |
| `HOST`, `PORT`           | `127.0.0.1`, `3000`        | Standalone Bun dashboard listener                                                                         |
| `PIKO_CHANGE_URL`        | unset outside Tako configs | Optional post-commit notification endpoint                                                                |
| `PIKO_CHANGE_TOKEN`      | Tako secret                | Shared API-to-dashboard credential; never sent to browsers                                                |
| `PIKO_CORS_ORIGINS`      | unset (loopback only)      | Extra origins allowed to read `/api/read/*`; see [local pages](docs/dashboards.md#local-pages)            |

## Use it

1. **Settings:** create a project, then add named **sources** such as Website, iOS app, or CLI. All sources use the same analytics UI. Icons follow the source name automatically, or can be chosen from a predefined Hugeicons set; no URL is needed. Create a key for a specific source and copy it while visible. Only its SHA-256 hash and display prefix are stored.
2. **Overview:** select a project, source (or **All sources**), and date range. Every source has the same widgets and query choices; Overview includes all event names. A combined project shares storage and retention. Missing identity or duration is shown honestly as unavailable.
3. **Events:** select an event, measure, grouping, and optional typed property filter. Counts, distinct actors, numeric sum/average, and duration p50/p95 run in DuckDB. Charts, grouping, filtering, and event pagination are server-side. Click an event for its original typed envelope.
4. **Logs:** search messages, filter by severity, service, and context, inspect structured records, and follow live logs. Services send structured JSON or OTLP/HTTP with separate `pl_` log keys created in Settings → Logs. Each project keeps logs in its own `logs/<project-id>.duckdb` with an independent seven-day default retention. See [application logs](docs/logs.md).

There is no built-in login, admin token, password, or admin session cookie. Management mutations use an `X-Piko-Admin: 1` request marker to prevent cross-site form submissions; it is not a secret or authorization mechanism. Cloudflare Access is the authentication boundary.

Click an Overview breakdown row to filter the dashboard in place; **View matching events** opens the filtered event stream. Page and referrer rows offer a separate external-link action on hover or keyboard focus. See [the dashboard guide](docs/dashboard.md) for drilldowns, typed filters, and date behavior.

Project, source, range, chart choices, applied Events queries, and Logs filters live in the URL. For example, `/projects/orbit?source=all&period=month`. One date picker provides presets, custom calendar dates, and previous/next navigation for calendar periods and fixed ranges. Custom dates use inclusive UTC days as explicit `from` / `to` timestamps (the API end is exclusive); they do not archive results. Chart grouping adjusts automatically to the chosen range. Reload, sharing, and browser history restore the view.

## Dashboards and MCP

Dashboards are JSON documents that the API owns, written over MCP by the AI agent you already use (Claude Code, Codex or anything that speaks MCP). Each widget runs typed event and log queries, formulas and guarded read-only SQL; every save is validated and timed, and revisions let you undo. Dashboards appear under Overview in the sidebar, and named queries can be saved as views under Events and Logs.

```sh
claude mcp add --transport http piko http://127.0.0.1:3000/mcp
```

Remote setups, the Codex config, the document reference, worked examples (including weekly churn in SQL) and the read-only `/api/read` surface for your own local pages are in [custom dashboards, views and MCP](docs/dashboards.md). Give an agent only the read-only token if it should not change anything; see [access](docs/access.md#mcp-and-read-only-access) and [privacy](docs/privacy.md#ai-agents-and-mcp). Errors and endpoints are in the [API reference](docs/api.md#dashboards-views-and-mcp).

See [API and data semantics](docs/api.md), [collection examples and identity](docs/collection.md), and [benchmark methodology/results](docs/benchmark.md).

### SDKs

- [JavaScript / TypeScript — `@piko/sdk`](sdk/typescript/README.md): zero runtime dependencies, ESM and TypeScript declarations, explicit sends and a privacy-aware browser tracker.
- [Rust — `piko-sdk`](sdk/rust/README.md): standalone async collection using reqwest/rustls, Tokio, serde/serde_json, uuid, and chrono. It does not pull in the API server or databases.

Both support typed properties, batches, stable event IDs across bounded retries, and persistence acknowledgments. Packages are available from this checkout; they have not been published to registries. The linked guides cover local installation and examples.

Existing projects migrate automatically to an initial source; existing keys and counts remain valid. Back up the stopped API's entire data directory before upgrading. Restoring that backup is required to downgrade to a pre-source binary. See [source and migration semantics](docs/api.md#projects-and-sources). The HTTP paths still use `/products` for existing integrations.

## Privacy defaults

Collection starts without visitor, session, or installation identifiers. The browser tracker honors DNT/GPC, leaves campaign capture off until explicitly configured, and offers pre-send filtering plus an opt-out that discards queued data. The CLI example requires an explicit opt-in. New projects created in Settings start with one-year retention (365 days). Retention is configurable per project in Settings; existing projects keep their configured value.

Piko does not derive analytics identity from IP addresses or user-agent information. Paths, custom properties, and optional persistent IDs are still data you choose to collect; they are not automatically anonymized. Read [the privacy model and collection controls](docs/privacy.md) before integrating private application routes.

## Checks

```sh
bun run fmt
bun fmt:check
bun typecheck
bun lint
bun test
bun run build
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Use `bun run fmt`: bare `bun fmt` runs Bun's built-in formatter and reformats unrelated files. `bun test` runs SDK and test-runner validation tests (scoped by `bunfig.toml`). `bun test:e2e` starts two dedicated Tako apps at `https://piko-e2e.test` and `https://piko-e2e-api.test`, runs real Chromium tests, then stops those apps and deletes their temporary databases. Initialize local TLS and the notification secret once with `bun dev`; the preview need not be running during tests. No seed is needed. To run a subset, use `bun test:e2e tests/analytics-chart.spec.ts`.

Every run gets fresh storage under `.tako/e2e/<run-id>/`. Test URLs are set by the runner, existing URL overrides cannot point it at the preview, and direct Playwright runs are rejected. A preflight requires an empty test database before any fixtures are created. Test failure, Ctrl-C, and SIGTERM all run teardown. A lock prevents simultaneous runs from sharing the test hosts. If a process is force-killed, follow the [test recovery instructions](docs/tako.md#browser-tests); its data remains separate from the preview. If Chromium is absent, install it with `bun node_modules/@playwright/test/cli.js install chromium`.

```sh
cargo build --release -p piko
bun benchmark
```

The benchmark starts its own API process with a temporary data directory and deletes only that directory afterward. It never writes to your running workspace. See its report for **measured** throughput, latency, and memory; no production capacity claim is implied.

See [the verification record](docs/verification.md) for measured checks and their limits.

## Scope and limitations

- External access control, one local API process, one disk. API updates briefly interrupt requests: native Tako requires an ingress gate and maintenance window; Compose uses stop-first replacement. Overlapping API processes are unsupported. No replication, multi-user permissions, automatic backups, or online schema migration framework yet.
- Browser ingestion keys are intentionally public and write-only. They are not anti-abuse credentials; a key holder can submit fabricated events. There is global capacity backpressure, but no per-key fairness or bot detection.
- Identity is explicit, optional, and project-scoped. There is no IP/user-agent fingerprinting. The browser tracker defaults to unidentified events and always honors Do Not Track and Global Privacy Control. Installations are distinct from website visitors and sessions.
- Settings → Display controls the event timezone for this browser, including event inspection. Stored timestamps, JSON exports, chart buckets, and date-range boundaries remain UTC. Date ranges are half-open; today is partial. Local-time/DST aggregation is not supported yet.
- Pagination is bounded offset pagination, ordered by time and event ID. Each query uses a consistent database snapshot, but different pages may shift when new events arrive. Top breakdowns are limited to 12 groups, event-name discovery to 100 names, filters to 8, pages to 10,001, and page size to 100.
- Delivery from browsers/CLIs is best effort with bounded retries. A flush confirms attempted delivery, not guaranteed delivery. Deduplication lasts while the event remains retained, not forever.
- No funnels, session replay, alerts, or distributed storage. Custom dashboards are written by an agent or by script, not dragged together in the UI, and their SQL is read-only and guarded.

[Liwan](https://github.com/explodingcamera/liwan) informed the embedded-storage direction. Piko has its own implementation and product model, with equal support for websites and tools.

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
