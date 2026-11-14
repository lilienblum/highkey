# API and semantics

The dashboard talks to this API over HTTP; the API does not serve frontend files. There is no application login, admin token, or admin session. Protect management access with Cloudflare Access and keep the origin private; see [access configuration](access.md). Ingestion still requires a source-scoped write-only ingestion key. Its key resolves the target project and source; its events go to `products/<product-id>.duckdb`. SQLite holds the shared project/source/key catalog and settings. The public API keeps its existing `/products` paths and `product_id` fields; “project” is the interface name for the same entity.

## Management

| Method     | Path                            | Body/result                                                         |
| ---------- | ------------------------------- | ------------------------------------------------------------------- |
| GET / POST | `/api/products`                 | List / create `{ name, retention_days }`                            |
| PATCH      | `/api/products/:id`             | Edit name and retention (1–3650 days)                               |
| GET / POST | `/api/products/:id/keys`        | List metadata / create `{ label, source_id }` → full key shown once |
| DELETE     | `/api/products/:id/keys/:keyId` | Revoke key, scoped to product                                       |
| POST       | `/api/products/:id/query`       | Parameterized analytics query below                                 |
| POST       | `/api/cleanup`                  | Run the same retention cleanup as the hourly job                    |
| GET        | `/health`                       | Process health, no credentials required                             |

Management mutations require `X-Piko-Admin: 1`. This public request marker prevents cross-site form submissions; it is **not authentication**. The API grants no management CORS access. Network access to management must be controlled by Cloudflare Access (or a trusted private network). Ingestion keys grant no bypass through Access and are never used as management credentials.

## Projects and sources

A project owns one analytics DuckDB database, a separate log database, independent retention for each, and any number of sources. A source is a named integration such as Website, iOS app, or CLI. All sources have the same analytics capabilities; there is no project or source type. Source names are unique within a project (ASCII case-insensitive). Creating a project automatically creates an initial source named **Events**, which can be renamed. Project responses include a stable, unique `slug` and `sources` with `id`, `product_id`, `name`, `slug`, `icon`, and `created_at`.

Application logs use separate source-scoped keys, ingestion endpoints, queries, and retention. See [application logs](logs.md) for the JSON/OTLP collection and management contracts.

- `GET /api/products/:id/sources`: list sources.
- `POST /api/products/:id/sources` with `{ "name": "iOS app" }`: create a source with an automatic icon.
- `PATCH /api/products/:id/sources/:sourceId` with `{ "name": "iOS app", "icon": "ios" }`: save a name and optional icon without changing its ID or historical attribution. As with the existing edit endpoint, send the complete editable representation; an omitted or null icon selects Automatic.
- `POST /api/products/:id/keys` with `{ "label": "iOS release", "source_id": "SOURCE_UUID" }`: create a write-only key for that source. Omitting `source_id` selects the initial source. Key metadata and creation responses include `source_id`.

`icon` accepts `website`, `ios`, `android`, `mobile`, `terminal`, `desktop`, `server`, `code`, `package`, `game`, or `generic`. An omitted/null value is stored as null: the dashboard derives a visual icon from common platform words in the current name, with a cube fallback. Explicit choices stay fixed across renames. Icons never filter events, select metrics or integration languages, or infer user/device identity. Unknown icons return 400; obsolete `kind` fields are rejected with 422.

Keys cannot move between sources or projects. Foreign-project source IDs are rejected. Source deletion and merging are not supported; revoke a source's keys to stop new authorized intake.

Slugs are allocated from the project name on creation, with numeric suffixes for collisions. Renaming keeps the slug unchanged. Schema 6 assigns slugs to existing projects without changing IDs, keys, sources, or event files. HTTP management endpoints continue to use UUIDs; the dashboard resolves its URL slug through the catalog. Slugs are identifiers, not credentials.

Sources get slugs the same way, unique within their project and at most 64 characters; a name without ASCII letters or digits becomes `source`. The initial source is `events`. `all` is reserved for the combined view, so a source named All becomes `all-2`. Schema 7 assigns slugs to existing sources in creation order without changing their IDs. Dashboard URLs name the source by slug (`?source=web-app`); older links with a source ID still open and are rewritten to the slug.

### Existing data

Stop the API and back up the whole data directory before updating. Catalog schema 3 adds nullable `sources.icon` and removes the obsolete `kind` columns from projects and sources. Existing sources use Automatic, retaining their names, IDs, creation times and key assignments. The migration does not rewrite analytics events. Repeated startup preserves subsequent icon choices.

For catalogs predating Sources, migration first creates one initial source per project and assigns its existing keys. Each older DuckDB file receives an additive `source_id` column when opened; historical events belong to that initial source. Attribution is never guessed from the free-form event `source` label. Counts, event IDs, and key values remain unchanged. Older API binaries cannot use the new catalog; downgrading requires restoring the complete pre-upgrade backup. Management clients must stop sending `kind`; ingestion SDKs are unchanged.

## Ingestion

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

- `timestamp`: optional RFC3339; normalized to UTC. Omitted timestamps use receipt time. A time older than product retention or >5 minutes in the future is rejected.
- `actor_id`: optional 1–128 byte opaque ID. Requires `identity_kind` (`visitor`, `installation`, or `actor`), and vice versa. Distinct counts namespace actors by product and identity kind.
- `session_id`: optional 1–128 byte ID, allowed only for visitor identity. Sessions count distinct `(actor_id, session_id)` pairs within the selected range, not globally completed sessions.
- `properties`: up to 32 flat entries. Values must be strings (≤2048 bytes), JSON numbers, or booleans. Arrays, objects, and null are rejected. Keys use the same character rules as event names. Numeric-looking strings stay strings and are excluded from numeric measures.
- `received_at`: set by the server. Both timestamps are stored as integer UTC milliseconds; queries filter by event time.

Successful response: **200 `{ "accepted": 2, "duplicates": 1 }`**, only after DuckDB commits. One invalid event rejects the whole HTTP batch. Duplicate `(product_id, event_id)` values use the **first committed payload** and never overwrite it. Duplicates within the same queued transaction also use first occurrence. Two projects may reuse the same event ID independently. Sources within one project share the deduplication namespace: use globally unique event IDs, including across source keys.

On network failure, timeout, or 5xx/429, retry **the exact same IDs and timestamps**, using capped backoff and `Retry-After`. Do not regenerate IDs. A 503 after the acknowledgment deadline may mean the write committed later; retrying resolves this ambiguity safely. Invalid payloads return 400/422 (or 413 for oversized bodies); invalid/revoked keys return 401. Do not retry these unchanged. No dedup tombstone remains after retention deletes an event. Explicit old timestamps are rejected, but a new current timestamp with an expired ID can count again.

Key authorization and retention validation occur at request acceptance. Revocation rejects subsequent authorizations; already-authorized in-flight requests may finish. Retention changes apply at the next cleanup. Ingestion is deliberately CORS-enabled without cookies; management is not.

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

Ranges are **[from, to)**, UTC. `bucket` accepts `hour`, `day` (default), `week`, or `month`. Hours and days align to UTC boundaries; calendar weeks start Monday at 00:00 UTC, and calendar months start on the first day at 00:00 UTC. Edge buckets include only events inside the selected range. Weeks and months aggregate the underlying events directly, preserving distinct counts and percentiles. Ranges are limited to 366 days, or 31 days for hourly queries. Missing count/actor/sum buckets are zero; average/percentile buckets are null. `avg`, `sum`, `p50`, and `p95` require a property and include only JSON numeric values. Empty aggregate averages/sums/percentiles are null. Percentiles use DuckDB's continuous interpolation. Success rate includes only boolean `success` values. Overview duration includes numeric `duration_ms` only. Unknown identities do not count as a distinct actor.

Measures: `count`, `actors`, `sum`, `avg`, `p50`, `p95`. Group by `name`, `source_id` (managed source), `source` (client label), `identity_kind`, or `property:<key>`. Numeric and boolean group labels retain their JSON types. Filters use `eq`, `ne`, `gt`, `gte`, `lt`, `lte`; ordered comparisons require numeric filter values and numeric properties. Missing properties do not satisfy comparisons, including `ne`. Strings and booleans are type-sensitive.

Set optional `source_id` to a source in the requested project to scope summary, series, groups, event rows, and event-name discovery; omit it for the combined view. A foreign or missing source returns 404. Event rows include server-assigned `source_id`. Source-group labels are stable IDs; resolve names from the project catalog. Identity is still explicit and project-scoped by identity kind; sources do not automatically link people across apps.

Response includes `summary`, zero-filled `series`, top-12 `groups`, paginated `events`, and `event_names`. All components run against one transaction snapshot. JSON values are bound; identifiers and operations are validated. No arbitrary SQL is accepted.

## Dashboards, views and MCP

Custom dashboards are `piko.dashboard/v1` documents stored by the API, and saved views are named queries for the Events and Logs pages. [The dashboards guide](dashboards.md) documents the document, formulas, SQL, limits and examples. Read paths and MCP tools take a project by UUID or slug; write paths (`/api/products/:id/...`) take its UUID, like the other management endpoints.

### Read paths

Everything under `/api/read` is non-mutating whatever its method, needs no `X-Piko-Admin` marker, and answers cross-origin requests from loopback origins and `PIKO_CORS_ORIGINS` (see [local pages](dashboards.md#local-pages)). Scope a read-only Access token to this prefix; see [access](access.md#mcp-and-read-only-access).

| Method | Path                                                      | Result                                                                              |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/read/products`                                      | Projects                                                                            |
| POST   | `/api/read/products/{project}/query`                      | The analytics query above                                                           |
| POST   | `/api/read/products/{project}/logs/query`                 | The [log query](logs.md)                                                            |
| POST   | `/api/read/products/{project}/widgets/run`                | Run one widget: `{ widget, from, to, bucket?, source_id? }`                         |
| GET    | `/api/read/products/{project}/catalog`                    | Event names and properties, log services and levels, sources, SQL columns, limits   |
| GET    | `/api/read/products/{project}/dashboards`                 | Summaries: `id`, `slug`, `name`, `description`, `revision`, `updated_at`, `widgets` |
| POST   | `/api/read/products/{project}/dashboards/validate`        | `{ document }` → `{ valid, errors, warnings }`; nothing is saved                    |
| GET    | `/api/read/products/{project}/dashboards/{key}`           | `{ id, slug, revision, updated_at, document }`                                      |
| GET    | `/api/read/products/{project}/dashboards/{key}/revisions` | Kept revisions, newest first, with their origin                                     |
| GET    | `/api/read/products/{project}/views`                      | Saved views; `?kind=events` or `?kind=logs` narrows                                 |
| GET    | `/api/read/products/{project}/views/{key}`                | One view; pass `kind` when both kinds share the slug                                |
| GET    | `/api/read/schemas/dashboard.v1.json`                     | The document's JSON Schema                                                          |
| any    | `/api/read/mcp`                                           | MCP, read tools only                                                                |

Widget runs use the shared query slots but never take the last free one, and each is bounded by the widget's `timeout_ms` (default 5,000; 1,000-10,000), so dashboards cannot starve the other queries.

### Write paths

These sit with the management routes: they need `X-Piko-Admin: 1`, and no CORS headers are sent for them. Send `X-Piko-Origin: dashboard` only from the dashboard proxy; it marks the revision's origin (otherwise the origin is `api`).

| Method | Path                                                     | Body → result                                                              |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| POST   | `/api/products/:id/dashboards`                           | `{ document }` → stored dashboard plus `bench` and `warnings`              |
| PUT    | `/api/products/:id/dashboards/:key`                      | `{ base_revision, document }` → the same; `409 revision_conflict` if stale |
| POST   | `/api/products/:id/dashboards/:key/revisions/:n/restore` | Writes revision `n` again as a new revision                                |
| DELETE | `/api/products/:id/dashboards/:key`                      | 204; the dashboard and its revisions are gone                              |
| POST   | `/api/products/:id/views`                                | `{ document }` → the stored view                                           |
| PUT    | `/api/products/:id/views/:key`                           | `{ document }` replaces the view in full; its kind cannot change           |
| DELETE | `/api/products/:id/views/:key`                           | 204; `?kind=` when both kinds share the slug                               |
| any    | `/api/mcp`                                               | MCP, every tool                                                            |

Every dashboard or view write counts against 30 per minute per project, shared with MCP (see [error codes](#error-codes)). Saves are validated and each new or changed widget is timed before anything is stored. Slugs come from the name; `:key` is a slug or the UUID.

### MCP

`/api/mcp` and `/api/read/mcp` speak MCP over streamable HTTP with JSON responses. The dashboard also serves `/mcp`, a short address that forwards to `/api/mcp`; it is the one the agent guide shows. Any request that carries a browser `Origin` header is refused, so a web page cannot drive MCP; clients such as Claude Code and Codex send none. Bodies are limited to 256 KiB like every other request. The tools, resources (`piko://schema/dashboard.v1`, `piko://docs/dashboards`) and the `build_dashboard` prompt are listed under [Ask your AI](dashboards.md#ask-your-ai). Tools that revoke keys or delete need `confirm` equal to the id or slug.

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

`error` is the message, `code` is stable and meant for programs, `errors[].path` is a JSON Pointer into what you sent (or the tool argument), and `hint` says how to fix it. `warnings` appear on validation and save results and never block a save. A failing MCP tool returns this body as an error result, plus `retry_after_secs` where HTTP sends `Retry-After`. Older endpoints, such as management and ingestion, return only `{ "error": "..." }`; ingestion's capacity error keeps its wording, `Capacity exhausted; retry with the same event IDs`.

| Code                | HTTP | Meaning                                                                                                         | What to do                                                                     |
| ------------------- | ---- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `invalid_document`  | 400  | A dashboard or view document failed parsing, a rule or SQL verification                                         | Fix each `errors[].path` using its hint, then resend                           |
| `invalid_argument`  | 400  | An MCP read tool argument is wrong, such as a time that does not parse                                          | Fix the argument named in `errors[].path`                                      |
| `invalid_input`     | 400  | An MCP workspace tool (projects, sources, keys, settings) refused its input                                     | Fix the argument named in `errors[].path`                                      |
| `invalid_kind`      | 400  | `kind` is not `events` or `logs`                                                                                | Use `events` or `logs`                                                         |
| `confirm_mismatch`  | 400  | MCP `confirm` does not equal the slug or id; nothing changed                                                    | Pass the exact slug (dashboards, views) or id (keys) the hint shows            |
| `limit`             | 400  | 50 dashboards or 100 views per project reached                                                                  | Delete one first                                                               |
| `too_slow`          | 400  | A widget exceeded its save-time budget (3 s or its `timeout_ms`; 15 s per save)                                 | Narrow the range, filter earlier or bound SQL with `$from` and `$to`           |
| `not_found`         | 404  | No such dashboard, view, project, source or revision; the hint names the nearest slugs                          | Correct the slug                                                               |
| `revision_conflict` | 409  | `base_revision` is older than the stored revision; the body carries `revision`                                  | Read the dashboard again, merge, save with the new revision as `base_revision` |
| `ambiguous_view`    | 409  | An events view and a logs view share the slug                                                                   | Pass `kind` (or write `kind` in the document)                                  |
| `conflict`          | 409  | An MCP workspace tool hit a conflict, such as a name that already exists                                        | Choose another value                                                           |
| `rate_limited`      | 429  | More than 30 dashboard or view writes in a minute for the project, HTTP and MCP together; failed attempts count | Wait `Retry-After` seconds (`retry_after_secs` over MCP)                       |
| `busy`              | 503  | Piko had no free query slot: for a save's benchmark (`Retry-After: 5`) or any other request (`Retry-After: 1`)  | Retry in a few seconds                                                         |
| `query_timeout`     | 503  | A widget run did not finish within its `timeout_ms`; no `Retry-After`, since it repeats                         | Narrow the widget or raise `timeout_ms` (up to 10,000)                         |
| `internal`          | 5xx  | An MCP workspace tool failed unexpectedly                                                                       | Retry once; check the API log                                                  |

### Live hints, envelope v2

Dashboard and view writes publish a post-commit hint like ingestion does. The native Tako webhook and the dashboard channel carry `{ "version": 2, "changes": null | [{ "product": "<uuid>", "signals": ["events", "logs", "dashboards"] }] }`. Signals are coalesced per project over 250 ms, and more than 64 projects collapse to `changes: null` (refresh everything). The envelope holds ids and signal names only, never events, logs, documents or credentials. The dashboard still accepts the version 1 envelope (`{ "products": [...] }`, meaning events) from an older API during a rolling update. Compose has no channel and polls instead.

## Resource model

A dedicated writer thread groups requests by product and drains up to 16 requests over an 8 ms window, appends typed rows into temporary DuckDB staging, deduplicates, and commits one set-based insert. Both the queue and concurrent ingestion body-processing slots default to 64. Envelopes are capped at 100 per request. Queue/body capacity exhaustion returns 503 with `Retry-After: 1`. The dashboard gateway also admits at most 64 pending ingestion uploads per process, with a 13-second total upload/upstream deadline. Oversized uploads return 413; gateway overload returns 503 with `Retry-After: 1` and ingestion CORS headers.

Up to four query connections are globally admitted by a semaphore, each cloned from the selected product’s DuckDB instance. At most eight product instances are cached; the least recently used inactive instance is closed when opening another. Active query/writer leases prevent eviction. If all eight are pinned, opening another returns 503. Queries run in `spawn_blocking`; the permit stays held until the actual query finishes even if the client disconnects. SQLite operations also run in bounded `spawn_blocking` tasks, using independent WAL connections and a 2-second busy timeout. Each product instance uses two execution threads and a 64 MB buffer memory limit, and spills at most 1 GiB to its temporary directory (a query that needs more fails); total process RSS can exceed this limit because not every allocation is tracked by DuckDB. Query admission fails fast with 503. There is no unbounded wait queue for queries.

On Linux the API also caps its own memory at startup with `RLIMIT_DATA`, because DuckDB's buffer limit does not cover every allocation (a single string or list value, for one). The default is 80% of the smaller of the process's cgroup memory limit (cgroup v2 `memory.max`, or v1 `memory.limit_in_bytes`) and the host's `MemTotal`. `PIKO_MEMORY_LIMIT` sets it instead: bytes with an optional `K`, `M` or `G` suffix (powers of 1,024), such as `2G`, or `0` or `off` for no ceiling. The API logs the value it chose at startup. A query that would pass the ceiling fails with DuckDB's Out of Memory error and the API keeps serving; an allocation of the API's own past it still ends the process, as the kernel's OOM killer would, but the rest of the host keeps its memory. The ceiling counts reserved as well as resident memory (thread stacks, for example), so it reads higher than RSS. Other platforms, such as macOS during development, set no ceiling.

Retention runs at startup and hourly, serialized through the writer. It deletes `event_time < now - retention_days` independently for each product. SIGINT/SIGTERM stop accepting HTTP work, finish accepted requests, drain the writer, and checkpoint the open product databases. Each product transaction commits independently; there are no cross-product write transactions.

### Optional browser-origin restrictions

`POST /api/products/:id/keys` accepts `allowed_origins`, an array of up to 16 HTTP(S) origins. For example, `["https://example.com", "https://*.example.com"]` accepts the apex and any subdomain. A wildcard alone does not include the apex; schemes and ports must match. Paths, queries, credentials, and standalone `*` are rejected. Empty or omitted arrays leave the key unrestricted, including for native and server clients.

Use `PATCH /api/products/:id/keys/:key_id` with `{"allowed_origins":[...]}` to edit an existing active key. An empty array removes the restriction. Key listing includes the normalized rules. Restricted ingestion rejects missing, `null`, malformed, duplicate, or mismatched `Origin` headers with **403 before persistence**. Rules apply to the whole request, including batches. Existing keys remain unrestricted after migration.

The ingestion CORS preflight stays public (preflights do not carry the ingestion key); the API enforces each key's policy on the actual POST. Origin restrictions reduce browser misuse and accidental collection. They are not authentication or proof of website ownership: a non-browser client can forge an Origin header. Use separate unrestricted keys for CLI/mobile/server senders; never weaken a browser key by accepting missing origins or trusting an event property or Referer as a substitute. Proxies must preserve the browser Origin header; Piko's dashboard proxy already does.

### Project websites and favicons

Project create/update accepts optional `website_url`. Bare domains default to HTTPS; only the origin is stored, and credentials, query strings, and fragments are rejected. Omission or `null` preserves an existing website; send `""` to clear it. A website is never required and does not silently change any key's origin policy. Settings provides **Use project website** when explicitly choosing a key's allowed origins.

On saving a website without a cached icon, the API tries `/favicon.ico`, `/favicon.png`, and `/apple-touch-icon.png`. Supported raster types are ICO, PNG, JPEG, and WebP; SVG, HTML discovery, redirects, and remote icon services are deliberately not used. The default project icon remains if retrieval or rendering fails. Cached bytes survive restarts and are invalidated when the website changes. Saving again retries a missing icon.

`GET /api/products/:id/favicon` returns the cached image, or 404 if absent. `favicon_version` in project responses identifies the cached bytes. This is a management route: keep it under the same edge protection as other project endpoints. Dashboard image requests stay on the Piko origin; only the API contacts the website, without visitor identifiers or browser credentials.

Retrieval allows public HTTP/HTTPS addresses on their standard ports only. All resolved addresses are checked and pinned for the request; private, loopback, link-local, special-purpose and translated address ranges, proxies, and redirects are blocked. Downloads are limited to 256 KiB, two concurrent jobs, and a four-second overall deadline. A failed favicon does not prevent saving a project. An opt-in network smoke check is available with `cargo test -p piko --lib public_favicon_smoke -- --ignored`.
