# Privacy model

Highkey does not store visitor IPs, raw user agents, or city as analytics context. At insertion, ephemeral inputs can produce country/region, browser, OS, device family and bot labels. Location stays unknown without an operator-supplied network lookup. Page titles, external referrer paths and URL fragments require explicit tracker options. Data goes to your configured collector; opt-in notifications and exports can send selected data to destinations you configure.

## Defaults and explicit choices

| Surface               | Default                                                | Explicit choice                                                                 |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Browser identity      | No automatic visitor/session IDs or identifier storage | Per-source cookieless daily IDs or consented persistent random IDs              |
| Browser page metadata | Pathname and referrer hostname only                    | Omit or canonicalize paths; disable referrers; opt in to titles and hash routes |
| Campaigns             | No campaign parameters                                 | Allowlist individual UTM names or `ref`                                         |
| Privacy signals       | DNT/GPC stop collection                                | No override; absence is not consent                                             |
| Custom events         | Only caller-supplied scalar properties                 | Filter or drop with `beforeSend`                                                |
| CLI example           | Telemetry off; no installation ID                      | `HIGHKEY_TELEMETRY=1`; optional random installation ID                          |
| CLI opt-out           | `DO_NOT_TRACK=1` takes precedence                      | Host application owns its persistent preference                                 |
| Retention             | New Settings projects start at 365 days                | Set a project-specific window between 1 and 3650 days                           |
| Log retention         | Seven days, independently of events                    | Set 1–365 days in Settings → Logs                                               |

Persistent random IDs are pseudonymous, not anonymous. Highkey separates visitor/session identities from CLI installations, and all identities are scoped to a product in queries. Do not use emails, account names, machine names, or credentials as IDs or properties.

## Collection controls

Choose a collection policy before loading the tracker. `enabled: false` starts inert; `sanitizePath` can map private URLs to route patterns or omit the path; `collectReferrer: false` removes the referrer; and `beforeSend` can sanitize or drop any event. Exceptions from sanitizers drop the event. See [the collection guide](collection.md) for examples.

`collectTitle: true` adds the current page title, and `trackHashChanges: true` appends the fragment to the collected path and counts hash navigation. Both are off by default. Titles and fragments can contain account names or tokens; use `beforeSend` to review titles and `sanitizePath` to review the whole opted-in route.

For returning visitors, **Ask with Highkey** makes a read-only source-policy check before it shows the consent prompt. It saves the visitor’s allow or decline choice on the site’s origin and starts analytics only after Allow. Add a **Privacy preferences** button to let visitors withdraw at any time. The prompt collects no events to replay later. Off and Daily visitors do not need this prompt.

With your own consent manager, use `optOut()` for withdrawal. It stops future collection, discards the pending queue, aborts delivery, and clears that tracker's stored identity. Persist the user's choice in your application and honor it on subsequent loads. An abort cannot retract an event the collector has already received. Normal `shutdown()` attempts queued batches within one total deadline and is not an opt-out.

Pathnames can contain names, emails, order IDs, or access tokens. Hostnames can identify private tenants. Even a UTM value can contain personal data. Highkey deliberately avoids unreliable heuristic redaction. Use canonical routes and an allowlist of product categories, booleans, and numeric measurements that you actually need. The generic ingestion API preserves the events you explicitly submit; it cannot determine whether a string is personal information.

## Transport and infrastructure

The browser ingestion client omits cookies and Referer and rejects redirects. Copyable module snippets also use `referrerpolicy="no-referrer"` so loading the tracker does not disclose the embedding URL. Configure the same policy on the host page for other integration styles. Rust telemetry also refuses redirects.

Management requests are handled by the dashboard. The gateway forwards only the ingest paths and tracker to the collector. For events it forwards the bounded user agent, fetch mode and privacy signals; a verified client address is forwarded only under the explicit trusted-proxy configuration. It never forwards cookies, Referer or edge authentication headers. Ephemeral refresh hints contain no raw records, actor IDs or credentials. Notification destinations and private export are separate, explicitly configured delivery paths.

Network infrastructure still sees connection information such as IP addresses. Your hosting provider, reverse proxy, access logs, and backups have their own behavior and retention. Highkey's application defaults do not configure those systems or establish legal compliance. Everything except collection needs a signed-in person, an API key or an agent's token; see [access.md](access.md).

## What each app stores

- **The ingest app** stores nothing of its own and has no data directory. It writes accepted events and logs to ClickHouse and keeps, in memory only, recent key lookups (a key's hash, project, source, allowed origins and retention) for up to five seconds.
- **The dashboard** keeps project and source configuration, dashboard revisions, saved views, cohorts, exclusions, references, insight summaries and notification history in the management database. Ingestion key secrets are shown once and only their hashes and display prefixes are kept. Destination credentials are encrypted. Export streams temporarily checkpoint compressed payloads until the private object store acknowledges the upload.
- **Accounts**, in the same database: each person's name, email address, whether it is verified, a password hash (scrypt), a profile picture address if they signed in with GitHub or Google (and that provider's account id and tokens), two-factor secrets and hashed backup codes when they turn codes on, and the server-admin role and any ban. Organizations hold their name, slug, members with their roles, and pending invitations (email, role, inviter). **Sessions** record their IP address and user agent, as Better Auth does by default, so people can recognize their sessions; they expire after 7 days of disuse. API keys are stored hashed with their first characters, owner, organization, access, request counts and last use. Agent connections store the agent's registered name and redirect addresses, the person, organization and granted scopes, and hashed refresh tokens; access tokens are signed, short-lived and not stored. Deleting an account deletes its sessions, keys, connections and memberships.
- **ClickHouse** holds the events (`highkey.events`) and logs (`highkey.logs`) exactly as collectors sent them, plus their receipt times and expiry. It also holds the key registry `highkey.ingest_keys`, which mirrors the key hashes, sources, origins and retention from the management database so the ingest app can authorize requests, and one small database of views and one reader user per project. Its `query_log` keeps a record of recent queries for seven days, for diagnosing slow widgets.

## Isolation between projects

All projects share ClickHouse's two physical tables. The dashboard reads a project's data only as that project's own ClickHouse user, which is granted nothing but the project's views. Each view hard-codes the project and reads the shared tables on the user's behalf (`SQL SECURITY DEFINER`), so the user has no grant on the tables, the key registry or another project's views. Table functions, dictionaries and system tables are refused, and a read-only settings profile caps time, memory, threads, result size and concurrency without letting the user raise them. Dashboard documents carry no SQL: every query is one of Highkey's typed entities, so no user-written SQL reaches ClickHouse.

**ClickHouse is the isolation boundary between projects.** Development and tests run a pinned image (`scripts/clickhouse.ts`); run the same version, or newer, in production. Keep it upgraded on ClickHouse's security releases as part of running Highkey, and keep ClickHouse off the public Internet. Anyone who holds the admin or ingest password, or reaches the ClickHouse server outside Highkey, is outside this boundary. Projects inside one deployment are separated, and organizations reach only their own projects through Highkey; a ClickHouse administrator sees all of them.

## Updating an existing collector

Refresh the hosted tracker or update copied SDK files. Campaign capture requires an explicit `campaigns` list. A snippet requesting `identity: "persistent"` uses identifier storage only when the collector confirms that the source allows it. A stale snippet on an Off source cannot enable persistent identity. Cookieless IDs are scoped by project, source and UTC day, and restarting the collector changes its salt.

Changing identity to `none` stops using IDs but does not itself erase IDs from an earlier integration. To clear them, call `optOut()` using the same collector origin and `identityScope` (or key fallback) that created them, then start a new unidentified tracker if collection is still permitted. Previously committed events remain subject to the product's retention window.

## Retention and deletion

Retention is configured per project in Settings and applies to all its sources. New projects default to one year (365 days). Changing the default for new projects does not shorten existing projects' configured retention. Each row expires at its event time plus the retention, and ClickHouse deletes expired rows during background merges, so a row can outlast its retention until the next merge; `POST /api/cleanup` forces one. Shortening retention rewrites the expiry of the project's stored rows. Deletion is not a secure disk erase. Backups and snapshots require their own retention policy.

Application logs contain the messages, trace/request IDs, and typed attributes supplied by your services or OTLP collector. Highkey does not automatically redact or anonymize them. Apply redaction and sampling in the sending application or collector, and keep `pl_` log keys in server configuration. Logs live in their own table and follow their own retention policy. Existing backups retain data until you remove them independently.

There is no automatic personal-data classification or per-person erasure workflow in v1. Minimize collection up front, keep retention short, and verify the stored events in Events before rolling out a collector broadly.

## AI agents and MCP

When you connect an AI agent to Highkey's [MCP server](dashboards.md#ask-your-ai), what it can read goes to whatever model and service that agent uses. That is your decision, and Highkey's collection defaults do not cover it.

- `sample_events` and `sample_logs` return up to 20 raw events or logs from the last 7 days: names, properties, actor IDs, log messages and attributes. They exist so the agent can see real shapes, but they send the actual records to your AI client. `run_widget` with a list or table view can return raw rows as well. `describe_project` returns event names, property keys, services and levels.
- `create_key`, `create_log_key` and `connect_source` return the new key's secret to the client, once. A read-and-write connection can also create sources and projects, change retention and revoke keys, as far as its person's role allows.
- **To prevent writes and key secrets, grant read only.** Choose **Read only** when the agent asks to connect, or give a scheduled run a read-only API key and the `/api/read/mcp` address (see [access](access.md#agents-mcp)): it has no tool that changes anything or returns a secret. The sample tools and widget runs are still there, because they only read. To stop the agent seeing raw records at all, do not connect it, or connect it to an organization whose projects hold no sensitive data.
- Highkey does not redact what the agent reads. Minimize collection and keep retention short, as described above.
- Dashboards and saved views hold queries and formulas, not data. They are stored in the dashboard's management database and shown to anyone who opens the dashboard.

## Multiple sources

Project sources are named integration metadata, not device or person identifiers. A write-only key attributes an event to exactly one source; callers cannot override it in the payload. Combined analytics do not infer cross-device identity. If collectors deliberately reuse an opaque actor ID with the same identity kind within a project, distinct-actor counts deduplicate it across sources. Use independent random IDs when that linkage is unwanted, or omit identity entirely. Retention applies to the whole project, including all its sources.
