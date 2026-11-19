# API and semantics

Two applications serve Highkey's HTTP paths. The **ingest app** (`apps/ingest`) receives events and logs and serves the browser tracker. The **dashboard app** (`apps/dashboard`) serves the UI and every other path: projects, sources, keys, queries, dashboards, saved views, MCP and live hints. Neither app depends on the other at runtime; they share only ClickHouse, where events and logs are stored. The dashboard keeps accounts, organizations, the project, source and key catalog, settings, dashboards and views in its management database (the Tako database `highkey`, or `state.sqlite` without Tako) and mirrors what the ingest app needs into ClickHouse.

Every path except collection needs a signed-in session, an API key (`Authorization: Bearer hk_…` or `X-Api-Key`), or on `/mcp` an agent's OAuth token, and acts inside one organization with its person's current role; see [accounts and access](access.md). Ingestion requires a source-scoped, write-only ingestion key, which resolves the target project and source. The public API keeps its `/products` paths and `product_id` fields; "project" is the interface name for the same entity.

## Endpoints

| Path                                              | Served by            | Purpose                                                       |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `POST /api/ingest`                                | Ingest app           | [Analytics events](#ingestion)                                |
| `POST /api/logs/ingest`                           | Ingest app           | [Structured JSON logs](logs.md#connect-a-service)             |
| `POST /api/logs/v1/logs`                          | Ingest app           | [OTLP/HTTP logs](logs.md#opentelemetry)                       |
| `GET /tracker.js`                                 | Ingest app           | The browser tracker module ([collection](collection.md))      |
| `GET /health`                                     | Each app, for itself | Process health, no credentials required                       |
| `/api/auth/*`                                     | Dashboard            | Sign-in, accounts, organizations, invitations, agent OAuth    |
| `/api/products…`, `POST /api/cleanup`             | Dashboard            | [Management](#management) and [queries](#query)               |
| `/api/keys…`, `/api/connections…`, `/api/admin/*` | Dashboard            | [Accounts](#api-keys-connections-and-the-server-admin)        |
| `/api/read/*`                                     | Dashboard            | [Read paths](#read-paths), the only cross-origin surface      |
| `POST /api/mcp`, `POST /api/read/mcp`, `/mcp`     | Dashboard            | [MCP](#mcp)                                                   |
| `POST /_highkey/changes`, `GET /_highkey/runtime` | Dashboard            | [Live hints](#live-hints-envelope-v2) and whether they are on |

Route the three ingest paths and `/tracker.js` to the ingest app at the edge where you can, so ingestion never passes through the dashboard. If the edge sends everything to the dashboard (one Tunnel route, or local development), the dashboard forwards exactly those four paths to `HIGHKEY_INGEST_URL` and serves everything else itself. See [the forwarding limits](#capacity-and-limits).

## Management

| Method     | Path                                  | Body/result                                                                       |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| GET / POST | `/api/products`                       | List / create `{ name, retention_days, website_url? }`                            |
| PATCH      | `/api/products/:id`                   | Edit name, website and retention (1–3650 days)                                    |
| GET        | `/api/products/:id/favicon`           | The cached website icon, or 404                                                   |
| GET / POST | `/api/products/:id/sources`           | List / create `{ name, icon? }`                                                   |
| PATCH      | `/api/products/:id/sources/:sourceId` | Edit `{ name, icon? }`                                                            |
| GET / POST | `/api/products/:id/keys`              | List metadata / create `{ label, source_id?, allowed_origins? }` → full key, once |
| PATCH      | `/api/products/:id/keys/:keyId`       | Replace `{ allowed_origins }`                                                     |
| DELETE     | `/api/products/:id/keys/:keyId`       | Revoke the key, scoped to the project                                             |
| POST       | `/api/products/:id/query`             | The analytics query [below](#query)                                               |
| POST       | `/api/products/:id/move`              | `{ organization }` (id or slug): move it; needs admin or owner in both            |
| DELETE     | `/api/products/:id`                   | 204; hidden and its keys stopped; restorable for 7 days                           |
| GET        | `/api/deleted-products`               | Deleted projects still restorable, with `restorable_until`                        |
| POST       | `/api/deleted-products/:id/restore`   | The restored project, keys as they were                                           |
| POST       | `/api/cleanup`                        | Server admin: delete expired events and logs now; `{ removed, logs_removed }`     |

Log keys, log settings and the log query are listed in [application logs](logs.md#management-api). Query paths accept a project's slug as well as its UUID; the other management paths take the UUID.

Every path states the permission it needs (see [roles](access.md#organizations-and-roles)): a viewer's request to change something answers `403 forbidden`, and a project of another organization answers 404 like one that does not exist. Writes made with a session cookie must come from `HIGHKEY_PUBLIC_URL`'s origin (`403 cross_site` otherwise); requests for any other host answer `421`. Management paths send no CORS headers. Ingestion keys are never management credentials.

## API keys, connections and the server admin

| Method | Path                                   | Body/result                                                                                              |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET    | `/api/keys`                            | Your API keys in this organization (owners and admins: everyone's), never secrets                        |
| POST   | `/api/keys`                            | `{ name, access: "read" \| "write", expires_in_days? }` → `{ id, key }`, key once                        |
| DELETE | `/api/keys/:id`                        | Revoke a key (yours, or anyone's for owners and admins)                                                  |
| GET    | `/api/connections`                     | Agent connections: client, person, access, `last_used_at`                                                |
| DELETE | `/api/connections/:id`                 | Revoke a connection and its tokens                                                                       |
| GET    | `/api/admin/users?search=`             | Server admin: people, with role, ban and two-factor state                                                |
| GET    | `/api/admin/organizations?search=`     | Server admin: organizations with member and project counts                                               |
| POST   | `/api/admin/users/:id/ban`, `/unban`   | Server admin: ban (`{ reason? }`) or unban; a ban ends sessions, keys and agents                         |
| POST   | `/api/admin/users/:id/revoke-sessions` | Server admin: sign someone out everywhere                                                                |
| POST   | `/api/admin/users/:id/reset-link`      | Server admin: `{ link }`, a one-time password reset link valid for 24 hours                              |
| DELETE | `/api/admin/users/:id`                 | Server admin: delete an account (refused while they are an organization's only owner with other members) |

Keys and connections are managed from a signed-in session; an API key cannot create or revoke keys. Accounts, organizations, members and invitations are Better Auth's endpoints under `/api/auth` (for example `POST /api/auth/organization/invite-member`, whose response carries the invitation's `link`).

## Projects and sources

A project has events, logs, independent retention for each, and any number of sources. Its events and logs are rows in ClickHouse's shared `highkey.events` and `highkey.logs` tables. The dashboard reads them only as the project's own ClickHouse user, through views that hold only that project's rows; see [isolation between projects](privacy.md#isolation-between-projects).

A source is a named integration such as Website, iOS app, or CLI. All sources have the same analytics capabilities; there is no project or source type. Source names are unique within a project (ASCII case-insensitive). Creating a project automatically creates an initial source named **Events**, which can be renamed. Project responses include a stable, unique `slug` and `sources` with `id`, `product_id`, `name`, `slug`, `icon`, and `created_at`.

Application logs use separate source-scoped keys, ingestion endpoints, queries, and retention. See [application logs](logs.md) for the JSON/OTLP collection and management contracts.

- `GET /api/products/:id/sources`: list sources.
- `POST /api/products/:id/sources` with `{ "name": "iOS app" }`: create a source with an automatic icon.
- `PATCH /api/products/:id/sources/:sourceId` with `{ "name": "iOS app", "icon": "ios" }`: save a name and optional icon without changing its ID or historical attribution. Send the complete editable representation; an omitted or null icon selects Automatic.
- `POST /api/products/:id/keys` with `{ "label": "iOS release", "source_id": "SOURCE_UUID" }`: create a write-only key for that source. Omitting `source_id` selects the initial source. Key metadata and creation responses include `source_id`.

`icon` accepts `website`, `ios`, `android`, `mobile`, `terminal`, `desktop`, `server`, `code`, `package`, `game`, or `generic`. An omitted/null value is stored as null: the dashboard derives a visual icon from common platform words in the current name, with a cube fallback. Explicit choices stay fixed across renames. Icons never filter events, select metrics or integration languages, or infer user/device identity. Unknown icons return 400; obsolete `kind` fields are rejected with 422.

Keys cannot move between sources or projects. Foreign-project source IDs are rejected. Source deletion and merging are not supported; revoke a source's keys to stop new authorized intake.

Slugs are allocated from the project name on creation, with numeric suffixes for collisions. Renaming keeps the slug unchanged. Slugs are identifiers, not credentials.

Sources get slugs the same way, unique within their project and at most 64 characters; a name without ASCII letters or digits becomes `source`. The initial source is `events`. `all` is reserved for the combined view, so a source named All becomes `all-2`. Dashboard URLs name the source by slug (`?source=web-app`); links with a source ID still open and are rewritten to the slug.

## Ingestion

The ingest app serves this path. Locally it listens on `127.0.0.1:3001` (`bun run dev:standalone`); the dashboard on port 3000 forwards the same request.

```sh
curl http://localhost:3001/api/ingest \
  -H 'Authorization: Bearer pk_YOUR_WRITE_ONLY_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "event_id": "3529a1c5-46e9-4143-b0d7-3ad2fbb2fb0e",
    "name": "command_run",
    "source": "cli",
    "timestamp": "2026-11-01T02:00:00Z",
    "actor_id": "random-installation-id",
    "identity_kind": "installation",
    "properties": {
      "command": "build", "version": "1.4.2", "os": "linux", "arch": "x86_64",
      "success": true, "duration_ms": 142
    }
  }'
```

Send one envelope or `{ "events": [ ... ] }` with 1–100 envelopes. The body limit is 256 KiB. `event_id`, `name`, and `source` are required strings of 1–64 ASCII letters/digits or `_ - . /`. Unknown envelope fields (including `product_id`, `source_id`, and `received_at`) are rejected. The key alone authorizes and resolves the project and managed source. The envelope `source` remains a free-form client/transport label (for example `browser`, `ios`, or `cli`); the dashboard calls it **Client**. It cannot choose or override the managed source.

- `timestamp`: optional RFC3339; normalized to UTC. Omitted timestamps use receipt time. A time older than the project's retention or more than 5 minutes in the future is rejected.
- `actor_id`: optional 1–128 byte opaque ID. Requires `identity_kind` (`visitor`, `installation`, or `actor`), and vice versa. Distinct counts namespace actors by project and identity kind.
- `session_id`: optional 1–128 byte ID, allowed only for visitor identity. Sessions count distinct `(actor_id, session_id)` pairs within the selected range, not globally completed sessions.
- `properties`: up to 32 flat entries. Values must be strings (≤2048 bytes), JSON numbers, or booleans. Arrays, objects, and null are rejected. Keys use the same character rules as event names. Numeric-looking strings stay strings and are excluded from numeric measures.
- `received_at`: set by the server. Both timestamps are stored with millisecond precision in UTC; queries filter by event time.

Successful response: **200 `{ "accepted": 2, "duplicates": 1 }`**, sent only after ClickHouse has stored the new rows. One invalid event rejects the whole HTTP batch.

### Deduplication

Events are deduplicated by `(product_id, event_id)`. Two projects may reuse the same event ID independently. Sources within one project share the namespace: use globally unique event IDs, including across source keys.

- **Exact for 24 hours.** Before each insert, the ingest app looks up the batch's IDs among the project's events received in the last 24 hours. A repeated ID is reported in `duplicates` and not stored again. The **first copy wins**: a later copy never overwrites it. Repeats within one request, or within one batch of queued requests, also keep the first occurrence. Each project's batches are written one at a time, so a retry always sees the earlier write. Highkey's SDKs retry within a second, well inside the window.
- **After 24 hours, eventual.** An older repeat is stored. ClickHouse (a `ReplacingMergeTree` table) removes it during a background merge and keeps the earliest received copy. Queries do not wait for merges, so such a repeat can count until it is merged away. `duplicates` reports only repeats found within the window.
- **Two cases leave a lasting duplicate.** Merges only combine rows with the same sort key, `(product_id, UTC day of the event time, name, event_id)`, so two copies stay apart when:
  - a client omits `timestamp` and resends the event more than a day later, so the copy gets a later receipt time and day;
  - the same `event_id` arrives again with a different `name` more than 24 hours after the first.

  The SDKs fix the timestamp once, before any retry, and keep the name. Plain HTTP clients should do the same.

Exact deduplication assumes one ingest process. During an ingest update the old and new processes overlap for a few seconds; a retry that reaches the other process in that window can be stored twice, and a merge removes the copy later.

On network failure, timeout, or 5xx/429, retry **the exact same IDs and timestamps**, using capped backoff and `Retry-After`. Do not regenerate IDs. A 503 after the 10-second acknowledgment deadline may mean the write was stored later; retrying within the window resolves this safely. ClickHouse being unreachable, overloaded or slow also returns 503 with `Retry-After: 1`. Invalid payloads return 400/422 (or 413 for oversized bodies); invalid, revoked, or wrong-kind keys return 401; an origin a key does not allow returns 403. Do not retry these unchanged. A write ClickHouse rejects returns 500 `Database operation failed`.

### Keys and retention at the ingest app

The ingest app reads keys from ClickHouse's `highkey.ingest_keys` registry. The dashboard writes a key's row after each key, origin, source or retention change commits in the management database, and the minute `reconcile` (a Tako workflow; a timer without Tako) rewrites the whole registry, which repairs a write that failed. The ingest app caches each lookup for 5 seconds (an unknown key for 1 second), so revocation and origin changes take effect within 5 seconds. A new key works once its row is written. Requests already authorized may finish.

Each new row expires at its event time plus the key's current retention. Changing a project's retention also rewrites the expiry of the rows already stored, after the registry has the new retention, and once more after the 5-second cache has passed, for rows stored meanwhile; see [capacity and limits](#capacity-and-limits). If ClickHouse is unreachable, the change is saved and the next successful reconcile, within a minute of ClickHouse returning, applies it. Ingestion is deliberately CORS-enabled without cookies; management is not.

## Query

```json
{
  "from": "2026-10-01T00:00:00Z",
  "to": "2026-11-01T00:00:00Z",
  "bucket": "day",
  "event": "command_run",
  "source": "cli",
  "identity_kind": "installation",
  "measure": "avg",
  "property": "duration_ms",
  "group_by": "property:command",
  "filters": [{ "property": "success", "op": "eq", "value": true }],
  "page": 0,
  "page_size": 25
}
```

Ranges are **[from, to)**, UTC. `bucket` accepts `hour`, `day` (default), `week`, or `month`. Hours and days align to UTC boundaries; calendar weeks start Monday at 00:00 UTC, and calendar months start on the first day at 00:00 UTC. Edge buckets include only events inside the selected range. Weeks and months aggregate the underlying events directly, preserving distinct counts and percentiles. Ranges are limited to 366 days, or 31 days for hourly queries. Missing count/actor/sum buckets are zero; other measures' buckets are null. Numeric measures require a property and include only JSON numeric values. Empty aggregate averages/sums/percentiles are null. Percentiles interpolate between values (ClickHouse's `quantileExactInclusive`). Success rate includes only boolean `success` values. Overview duration includes numeric `duration_ms` only. Unknown identities do not count as a distinct actor.

Measures: `count`, `actors`, `sum`, `avg`, `min`, `max`, `p50`, `p95`. Group by `name`, `source_id` (managed source), `source` (client label), `identity_kind`, or `property:<key>`. Numeric and boolean group labels retain their JSON types. Filters use `eq`, `ne`, `gt`, `gte`, `lt`, `lte`; ordered comparisons require numeric filter values and numeric properties. Missing properties do not satisfy comparisons, including `ne`. Strings and booleans are type-sensitive. Up to 8 filters, pages 0–10,000, and page sizes 1–100.

Set optional `source_id` to a source in the requested project to scope summary, series, groups, event rows, and event-name discovery; omit it for the combined view. A foreign or missing source returns 404. Event rows include server-assigned `source_id`. Source-group labels are stable IDs; resolve names from the project catalog. Identity is still explicit and project-scoped by identity kind; sources do not automatically link people across apps.

The response includes `summary`, zero-filled `series`, top-12 `groups`, paginated `events`, and up to 100 `event_names`. Each part is a separate ClickHouse query run as the project's reader, so an event stored between them can appear in one part and not another. JSON values are bound as query parameters; identifiers and operations are validated. No SQL is accepted.

## Dashboards, views and MCP

Custom dashboards are `highkey.dashboard/v1` documents stored by the dashboard app, and saved views are named queries for the Events and Logs pages. Documents carry no SQL: every query is an events, logs, funnel or retention entity. [The dashboards guide](dashboards.md) documents the document, its queries, formulas, limits and examples. Read paths and MCP tools take a project by UUID or slug; write paths (`/api/products/:id/...`) take its UUID, like the other management endpoints.

### Read paths

Everything under `/api/read` is non-mutating whatever its method, and answers cross-origin requests from loopback origins and `HIGHKEY_CORS_ORIGINS` (see [local pages](dashboards.md#local-pages)). Pages and scripts read with a read-only API key; see [access](access.md#api-keys).

| Method | Path                                                      | Result                                                                              |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/read/products`                                      | Projects                                                                            |
| POST   | `/api/read/products/{project}/query`                      | The analytics query above                                                           |
| POST   | `/api/read/products/{project}/logs/query`                 | The [log query](logs.md#management-api)                                             |
| POST   | `/api/read/products/{project}/widgets/run`                | Run one widget: `{ widget, from, to, bucket?, source_id? }`                         |
| GET    | `/api/read/products/{project}/catalog`                    | Event names and properties, log services and levels, sources, retention, limits     |
| GET    | `/api/read/products/{project}/dashboards`                 | Summaries: `id`, `slug`, `name`, `description`, `revision`, `updated_at`, `widgets` |
| POST   | `/api/read/products/{project}/dashboards/validate`        | `{ document }` → `{ valid, errors, warnings }`; nothing is saved                    |
| GET    | `/api/read/products/{project}/dashboards/{key}`           | `{ id, slug, revision, updated_at, document }`                                      |
| GET    | `/api/read/products/{project}/dashboards/{key}/revisions` | Kept revisions, newest first, with their origin                                     |
| GET    | `/api/read/products/{project}/views`                      | Saved views; `?kind=events` or `?kind=logs` narrows                                 |
| GET    | `/api/read/products/{project}/views/{key}`                | One view; pass `kind` when both kinds share the slug                                |
| GET    | `/api/read/schemas/dashboard.v1.json`                     | The document's JSON Schema                                                          |
| POST   | `/api/read/mcp`                                           | MCP, read tools only; API keys only                                                 |

Widget runs wait at the dashboard's own query gates, so dashboards cannot take every slot an interactive page needs: event widgets share one fewer slot than `HIGHKEY_QUERY_CONCURRENCY` (default 4), and log widgets share one. A run waits for a slot until its deadline, and each run is bounded by the widget's `timeout_ms` (default 5,000; 1,000–10,000).

### Write paths

These sit with the management routes and need a member, admin or owner; no CORS headers are sent for them. Send `X-Highkey-Origin: dashboard` only from the dashboard UI; it marks the revision's origin (otherwise the origin is `api`).

| Method | Path                                                     | Body → result                                                              |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| POST   | `/api/products/:id/dashboards`                           | `{ document }` → stored dashboard plus `bench` and `warnings`              |
| PUT    | `/api/products/:id/dashboards/:key`                      | `{ base_revision, document }` → the same; `409 revision_conflict` if stale |
| POST   | `/api/products/:id/dashboards/:key/revisions/:n/restore` | Writes revision `n` again as a new revision                                |
| DELETE | `/api/products/:id/dashboards/:key`                      | 204; the dashboard and its revisions are gone                              |
| POST   | `/api/products/:id/views`                                | `{ document }` → the stored view                                           |
| PUT    | `/api/products/:id/views/:key`                           | `{ document }` replaces the view in full; its kind cannot change           |
| DELETE | `/api/products/:id/views/:key`                           | 204; `?kind=` when both kinds share the slug                               |
| POST   | `/api/mcp`                                               | MCP, every tool the credential allows                                      |

Every dashboard or view write counts against 30 per minute per project, shared with MCP (see [error codes](#error-codes)). Saves are validated and each new or changed widget is timed before anything is stored. Slugs come from the name; `:key` is a slug or the UUID.

### MCP

`/api/mcp` and `/api/read/mcp` speak MCP over streamable HTTP in its stateless form: each POST carries one JSON-RPC message and gets one JSON response, with no sessions and no server-sent events. Other methods return 405. `/mcp` is a short address for `/api/mcp`; it is the one the agent guide shows, and the resource agents' OAuth tokens are bound to. Without a token or key it answers 401 with a `WWW-Authenticate` header naming `/.well-known/oauth-protected-resource/mcp`, where an MCP client starts signing in; a read-only grant or key lists only the read tools. `/api/read/mcp` takes API keys only. Any request that carries a browser `Origin` header is refused with 403, so a web page cannot drive MCP; clients such as Claude Code and Codex send none. Bodies are limited to 256 KiB like every other request. The tools, resources (`highkey://schema/dashboard.v1`, `highkey://docs/dashboards`) and the `build_dashboard` prompt are listed under [Ask your AI](dashboards.md#ask-your-ai). Tools that revoke keys or delete need `confirm` equal to the id or slug.

### Error codes

Dashboard, view and MCP errors share one body:

```json
{
  "error": "Invalid dashboard document",
  "code": "invalid_document",
  "errors": [
    {
      "path": "/widgets/0/series/0/expr",
      "message": "unknown query `requets`",
      "hint": "did you mean `requests`?"
    }
  ],
  "warnings": []
}
```

`error` is the message, `code` is stable and meant for programs, `errors[].path` is a JSON Pointer into what you sent (or the tool argument), and `hint` says how to fix it. `warnings` appear on validation and save results and never block a save. A failing MCP tool returns this body as an error result, plus `retry_after_secs` where HTTP sends `Retry-After`. Management and ingestion return only `{ "error": "..." }`, except that query paths add `code` when ClickHouse is busy or not ready (`busy`, `analytics_unavailable`). Ingestion's capacity error keeps its wording, `Capacity exhausted; retry with the same event IDs`.

| Code                    | HTTP | Meaning                                                                                                                                                | What to do                                                                               |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `invalid_document`      | 400  | A dashboard or view document failed parsing or a rule                                                                                                  | Fix each `errors[].path` using its hint, then resend                                     |
| `invalid_argument`      | 400  | An MCP read tool argument is wrong, such as a time that does not parse                                                                                 | Fix the argument named in `errors[].path`                                                |
| `invalid_input`         | 400  | An MCP workspace tool (projects, sources, keys, settings) refused its input                                                                            | Fix the argument named in `errors[].path`                                                |
| `invalid_kind`          | 400  | `kind` is not `events` or `logs`                                                                                                                       | Use `events` or `logs`                                                                   |
| `confirm_mismatch`      | 400  | MCP `confirm` does not equal the slug or id; nothing changed                                                                                           | Pass the exact slug (dashboards, views) or id (keys) the hint shows                      |
| `limit`                 | 400  | 50 dashboards or 100 views per project reached                                                                                                         | Delete one first                                                                         |
| `too_slow`              | 400  | A widget exceeded its save-time budget (3 s or its `timeout_ms`; 15 s per save)                                                                        | Narrow its range, filter by event, property or service, or shorten a funnel or retention |
| `not_found`             | 404  | No such dashboard, view, project, source or revision; the hint names the nearest slugs                                                                 | Correct the slug                                                                         |
| `revision_conflict`     | 409  | `base_revision` is older than the stored revision; the body carries `revision`                                                                         | Read the dashboard again, merge, save with the new revision as `base_revision`           |
| `ambiguous_view`        | 409  | An events view and a logs view share the slug                                                                                                          | Pass `kind` (or write `kind` in the document)                                            |
| `conflict`              | 409  | An MCP workspace tool hit a conflict, such as a name that already exists                                                                               | Choose another value                                                                     |
| `rate_limited`          | 429  | More than 30 dashboard or view writes in a minute for the project, HTTP and MCP together; failed attempts count                                        | Wait `Retry-After` seconds (`retry_after_secs` over MCP)                                 |
| `busy`                  | 503  | No free query slot, or the project's ClickHouse query limit was reached: a save's benchmark (`Retry-After: 5`) or any other request (`Retry-After: 1`) | Retry in a few seconds                                                                   |
| `analytics_unavailable` | 503  | The project's ClickHouse user or views are not set up yet, or ClickHouse is unreachable (`Retry-After: 5`)                                             | Retry shortly; the dashboard sets up missing project access at startup and every minute  |
| `query_timeout`         | 503  | A widget run did not finish within its `timeout_ms`; no `Retry-After`, since it repeats                                                                | Narrow the widget or raise `timeout_ms` (up to 10,000)                                   |
| `internal`              | 5xx  | An MCP workspace tool failed unexpectedly                                                                                                              | Retry once; check the dashboard's log                                                    |

### Live hints, envelope v2

The ingest app posts a hint to `HIGHKEY_CHANGE_URL` (the dashboard's `/_highkey/changes`) after each insert that stored new rows; duplicate-only retries send none. Dashboard, view and workspace writes in the dashboard publish their own hint directly. Both reach browsers on the dashboard's ephemeral Tako channel as `{ "version": 2, "changes": null | [{ "product": "<uuid>", "signals": ["events", "logs", "dashboards"] }] }`. The ingest app coalesces signals per project over 250 ms, and more than 64 projects collapse to `changes: null` (refresh everything). The envelope holds ids and signal names only, never events, logs, documents or credentials. The dashboard also accepts the version 1 envelope (`{ "products": [...] }`, meaning events). Without Tako (`bun run dev:standalone`) there is no channel, and pages poll instead. See [realtime semantics](tako.md#realtime-semantics).

## Capacity and limits

**Ingestion.** The ingest app admits at most `HIGHKEY_QUEUE_CAPACITY` (default 64, 1–1024) concurrent event uploads and holds as many requests waiting for a write; log uploads have their own 16 and 16. Each request has a 12-second deadline, and its acknowledgment waits at most 10 seconds. Envelopes are capped at 100 per request and bodies at 256 KiB. Exhausted capacity returns 503 with `Retry-After: 1`. No blocking work runs on Tokio workers; every ClickHouse call is asynchronous network I/O.

**Writes.** Each project's requests are written one batch at a time, in arrival order, with up to 100 requests per batch. While a batch is in flight, new requests for that project collect into the next one, so batches grow with load. Up to four inserts run at once across projects, for events and for logs. Inserts use ClickHouse's asynchronous inserts and wait for them, flushed within 50 ms, into tables with `fsync_after_insert`, so an acknowledgment means ClickHouse has written the rows to disk. A failed insert fails every request in its batch.

**Dashboard forwarding.** When the dashboard forwards ingestion, it admits at most 64 pending uploads per process, with a 13-second total deadline. Oversized uploads return 413; overload, or an unreachable ingest app, returns 503 with `Retry-After: 1` and ingestion CORS headers. The dashboard forwards only the headers ingestion reads.

**Reads.** Every read of project data runs as that project's ClickHouse user, under a read-only profile with limits it cannot raise: 10 seconds per query, 1 GiB of memory, 2 threads, 10,000 result rows or 4 MiB, and 4 concurrent queries per project. ClickHouse workloads give ingestion priority for CPU and limit all project readers together to half the cores. One ClickHouse node still shares CPU and disk between reads and writes; these caps bound the interference, they do not remove it. `bun run test:load` checks that ingestion latency stays within its limits during heavy dashboard queries.

**Retention.** Rows carry an `expires_at` time (event time plus retention days), and ClickHouse's TTL deletes expired rows during background merges, not at the moment they expire. Changing a project's retention runs one `ALTER TABLE … UPDATE expires_at` mutation per signal for the project's rows and waits for it, then updates the key registry; shortening removes older rows at the next TTL merge. `POST /api/cleanup` forces that merge (`MATERIALIZE TTL`) and returns how many expired rows it found.

### Optional browser-origin restrictions

`POST /api/products/:id/keys` accepts `allowed_origins`, an array of up to 16 HTTP(S) origins. For example, `["https://example.com", "https://*.example.com"]` accepts the apex and any subdomain. A wildcard alone does not include the apex; schemes and ports must match. Paths, queries, credentials, and standalone `*` are rejected. Empty or omitted arrays leave the key unrestricted, including for native and server clients.

Use `PATCH /api/products/:id/keys/:key_id` with `{"allowed_origins":[...]}` to edit an existing active key; the ingest app applies the change within 5 seconds. An empty array removes the restriction. Key listing includes the normalized rules. Restricted ingestion rejects missing, `null`, malformed, duplicate, or mismatched `Origin` headers with **403 before anything is written**. Rules apply to the whole request, including batches.

The ingestion CORS preflight stays public (preflights do not carry the ingestion key); the ingest app enforces each key's policy on the actual POST. Origin restrictions reduce browser misuse and accidental collection. They are not authentication or proof of website ownership: a non-browser client can forge an Origin header. Use separate unrestricted keys for CLI/mobile/server senders; never weaken a browser key by accepting missing origins or trusting an event property or Referer as a substitute. Proxies must preserve the browser Origin header; the dashboard's ingest forwarding does.

### Project websites and favicons

Project create/update accepts optional `website_url`. Bare domains default to HTTPS; only the origin is stored, and credentials, query strings, and fragments are rejected. Omission or `null` preserves an existing website; send `""` to clear it. A website is never required and does not silently change any key's origin policy. Settings provides **Use project website** when explicitly choosing a key's allowed origins.

On saving a website without a cached icon, the dashboard tries `/favicon.ico`, `/favicon.png`, and `/apple-touch-icon.png`. Supported raster types are ICO, PNG, JPEG, and WebP; SVG, HTML discovery, redirects, and remote icon services are deliberately not used. The default project icon remains if retrieval or rendering fails. Cached bytes live in the management database, survive restarts, and are invalidated when the website changes. Saving again retries a missing icon.

`GET /api/products/:id/favicon` returns the cached image, or 404 if absent. `favicon_version` in project responses identifies the cached bytes. This is a management route: keep it under the same edge protection as other project endpoints. Dashboard image requests stay on the Highkey origin; only the dashboard server contacts the website, without visitor identifiers or browser credentials.

Retrieval allows public HTTP/HTTPS addresses on their standard ports only. Resolved addresses are checked and pinned for the request; private, loopback, link-local, special-purpose and translated address ranges, and redirects are blocked. Downloads are limited to 256 KiB, two concurrent fetches, and a four-second overall deadline. A failed favicon does not prevent saving a project.
