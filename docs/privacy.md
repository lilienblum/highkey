# Privacy model

Piko is built to minimize collection by default. It does not add IP addresses, user-agent strings, geolocation, device fingerprints, page titles, form values, command output, or account information to analytics events. It does not send analytics to a Piko-operated service. Data goes to the collector you configure and remains in your self-hosted storage: your own ClickHouse server and the dashboard's SQLite file.

## Defaults and explicit choices

| Surface               | Default                                      | Explicit choice                                       |
| --------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Browser identity      | No visitor/session IDs or identifier storage | Persistent random IDs, scoped to the product          |
| Browser page metadata | Pathname and referrer hostname only          | Omit or canonicalize paths; disable referrers         |
| Campaigns             | No campaign parameters                       | Allowlist individual UTM names                        |
| Privacy signals       | DNT/GPC stop collection                      | No override; absence is not consent                   |
| Custom events         | Only caller-supplied scalar properties       | Filter or drop with `beforeSend`                      |
| CLI example           | Telemetry off; no installation ID            | `PIKO_TELEMETRY=1`; optional random installation ID   |
| CLI opt-out           | `DO_NOT_TRACK=1` takes precedence            | Host application owns its persistent preference       |
| Retention             | New Settings projects start at 365 days      | Set a project-specific window between 1 and 3650 days |
| Log retention         | Seven days, independently of events          | Set 1–365 days in Settings → Logs                     |

Persistent random IDs are pseudonymous, not anonymous. Piko separates visitor/session identities from CLI installations, and all identities are scoped to a product in queries. Do not use emails, account names, machine names, or credentials as IDs or properties.

## Collection controls

Choose a collection policy before loading the tracker. `enabled: false` starts inert; `sanitizePath` can map private URLs to route patterns or omit the path; `collectReferrer: false` removes the referrer; and `beforeSend` can sanitize or drop any event. Exceptions from sanitizers drop the event. See [the collection guide](collection.md) for examples.

Use `optOut()` for withdrawal. It stops future collection, discards the pending queue, aborts delivery, and clears that tracker's stored identity. Persist the user's choice in your application and honor it on subsequent loads. An abort cannot retract an event the collector has already received. Normal `shutdown()` attempts queued batches within one total deadline and is not an opt-out.

Pathnames can contain names, emails, order IDs, or access tokens. Hostnames can identify private tenants. Even a UTM value can contain personal data. Piko deliberately avoids unreliable heuristic redaction. Use canonical routes and an allowlist of product categories, booleans, and numeric measurements that you actually need. The generic ingestion API preserves the events you explicitly submit; it cannot determine whether a string is personal information.

## Transport and infrastructure

The browser ingestion client omits cookies and Referer and rejects redirects. Copyable module snippets also use `referrerpolicy="no-referrer"` so loading the tracker does not disclose the embedding URL. Configure the same policy on the host page for other integration styles. Rust telemetry also refuses redirects.

Management requests never leave the dashboard. When the edge sends ingestion to the dashboard, it forwards only the three ingest paths and `/tracker.js` to the ingest app, with only the headers ingestion reads: `Accept`, `Content-Type`, `Content-Encoding`, `Authorization` (the ingestion key), `Origin`, and the CORS preflight headers. Browser cookies, referrers, user-agent strings, forwarded client IPs, and Cloudflare user identity headers are not forwarded. Ephemeral refresh notifications have no persisted channel history and contain only a version, affected project IDs and signal names (or a full-refresh hint), never event bodies, log records or actor IDs.

Network infrastructure still sees connection information such as IP addresses. Your hosting provider, Cloudflare, reverse proxy, access logs, and backups have their own behavior and retention. Piko's application defaults do not configure those systems or establish legal compliance. Keep management/query access behind the external access boundary described in [access.md](access.md).

## What each app stores

- **The ingest app** stores nothing of its own and has no data directory. It writes accepted events and logs to ClickHouse and keeps, in memory only, recent key lookups (a key's hash, project, source, allowed origins and retention) for up to five seconds.
- **The dashboard** keeps `state.sqlite`: projects and their website addresses and cached favicons, sources, ingestion and log key hashes with their display prefixes and allowed origins, retention settings, dashboards with their revisions, and saved views. Key secrets are shown once at creation and never stored; only their SHA-256 hashes are.
- **ClickHouse** holds the events (`piko.events`) and logs (`piko.logs`) exactly as collectors sent them, plus their receipt times and expiry. It also holds the key registry `piko.ingest_keys`, which mirrors the key hashes, sources, origins and retention from `state.sqlite` so the ingest app can authorize requests, and one small database of views and one reader user per project. Its `query_log` keeps a record of recent queries for seven days, for diagnosing slow widgets.

## Isolation between projects

All projects share ClickHouse's two physical tables. The dashboard reads a project's data only as that project's own ClickHouse user, which is granted nothing but the project's views. Each view hard-codes the project and reads the shared tables on the user's behalf (`SQL SECURITY DEFINER`), so the user has no grant on the tables, the key registry or another project's views. Table functions, dictionaries and system tables are refused, and a read-only settings profile caps time, memory, threads, result size and concurrency without letting the user raise them. Dashboard documents carry no SQL: every query is one of Piko's typed entities, so no user-written SQL reaches ClickHouse.

**ClickHouse is the isolation boundary between projects.** The image is pinned (`compose.yaml` and `scripts/clickhouse.ts` name the same tag). Keep it upgraded on ClickHouse's security releases as part of running Piko, and keep ClickHouse off the public Internet. Anyone who holds the admin or ingest password, or reaches the ClickHouse server outside Piko, is outside this boundary. Projects inside one deployment are separated; separate organizations should run separate deployments.

## Updating an existing collector

Refresh the hosted tracker or update copied SDK files. Campaign capture now requires an explicit `campaigns` list, and the `respectDoNotTrack` override has been removed. Existing integrations that explicitly request `identity: "persistent"` remain opted in; the new copyable snippet uses `none`.

Changing identity to `none` stops using IDs but does not itself erase IDs from an earlier integration. To clear them, call `optOut()` using the same collector origin and `identityScope` (or key fallback) that created them, then start a new unidentified tracker if collection is still permitted. Previously committed events remain subject to the product's retention window.

## Retention and deletion

Retention is configured per project in Settings and applies to all its sources. New projects created in Settings default to one year (365 days). Changing the default for new projects does not shorten existing projects' configured retention. Each row expires at its event time plus the retention, and ClickHouse deletes expired rows during background merges, so a row can outlast its retention until the next merge; `POST /api/cleanup` forces one. Shortening retention rewrites the expiry of the project's stored rows. Deletion is not a secure disk erase. Backups and snapshots require their own retention policy.

Application logs contain the messages, trace/request IDs, and typed attributes supplied by your services or OTLP collector. Piko does not automatically redact or anonymize them. Apply redaction and sampling in the sending application or collector, and keep `pl_` log keys in server configuration. Logs live in their own table and follow their own retention policy. Existing backups retain data until you remove them independently.

There is no automatic personal-data classification or per-person erasure workflow in v1. Minimize collection up front, keep retention short, and verify the stored events in Events before rolling out a collector broadly.

## AI agents and MCP

When you connect an AI agent to Piko's [MCP server](dashboards.md#ask-your-ai), what it can read goes to whatever model and service that agent uses. That is your decision, and Piko's collection defaults do not cover it.

- `sample_events` and `sample_logs` return up to 20 raw events or logs from the last 7 days: names, properties, actor IDs, log messages and attributes. They exist so the agent can see real shapes, but they send the actual records to your AI client. `run_widget` with a list or table view can return raw rows as well. `describe_project` returns event names, property keys, services and levels.
- `create_key`, `create_log_key` and `connect_source` return the new key's secret to the client, once. A full token can also create sources and projects, change retention and revoke keys.
- **To prevent writes and key secrets, withhold the full token.** Give the agent a read-only Access token and the `/api/read/mcp` path (see [access](access.md#mcp-and-read-only-access)): it has no tool that changes anything or returns a secret. The sample tools and widget runs are still there, because they only read. To stop the agent seeing raw records at all, do not connect it, or connect it to a project that holds no sensitive data.
- Piko does not redact what the agent reads. Minimize collection and keep retention short, as described above.
- Dashboards and saved views hold queries and formulas, not data. They are stored in the dashboard's `state.sqlite` and shown to anyone who opens the dashboard.

## Multiple sources

Project sources are named integration metadata, not device or person identifiers. A write-only key attributes an event to exactly one source; callers cannot override it in the payload. Combined analytics do not infer cross-device identity. If collectors deliberately reuse an opaque actor ID with the same identity kind within a project, distinct-actor counts deduplicate it across sources. Use independent random IDs when that linkage is unwanted, or omit identity entirely. Retention applies to the whole project, including all its sources.
