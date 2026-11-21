# Application logs

Application logs are stored in ClickHouse's `highkey.logs` table, separate from analytics events in `highkey.events`. Each project reads only its own rows, through its own ClickHouse user and views. Logs have their own keys, endpoints, queries and retention. The dashboard's SQLite store holds log key hashes and retention settings.

## Connect a service

Open **Settings → Logs**, select a source, and create a log ingestion key. The `pl_` secret is shown once. Keep it in your service or collector configuration. These keys only write logs to their own project and source; analytics keys cannot send logs, and log keys cannot send analytics or read data.

Send structured JSON to `/api/logs/ingest`. The ingest app serves it; when the edge sends everything to the dashboard, the dashboard forwards it unchanged.

```sh
curl --fail-with-body https://highkey.example.com/api/logs/ingest \
  -H "Authorization: Bearer $HIGHKEY_LOG_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"logs":[{
    "log_id":"checkout-42",
    "level":"info",
    "service":"checkout-api",
    "environment":"production",
    "message":"Order completed",
    "request_id":"request-42",
    "attributes":{"status":200,"cached":false,"duration_ms":18.4}
  }]}'
```

The response is `{"accepted":1,"duplicates":0}` after ClickHouse has stored the records. A single record object also works. If `log_id` or `timestamp` is omitted, the ingest app generates a time-ordered ID or uses receipt time; supply stable IDs for retry deduplication.

Deduplication follows the [event rules](api.md#deduplication), keyed on the project-scoped `log_id`. Retrying the same `log_id` within 24 hours returns a duplicate instead of adding another row, and the first copy wins. An older repeat is stored and later removed by a background merge. Merges only combine records with the same project, UTC day, `service` and `log_id`, so a resent record with a different `service`, or one without `timestamp` resent more than a day later, stays as a second row. Records without an ID never deduplicate.

| Field                       | Meaning                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `log_id`                    | Optional stable ID; 1–64 ASCII letters, digits, `_`, `-`, `.`, `/`               |
| `timestamp`                 | Optional RFC3339 event time, within log retention and at most five minutes ahead |
| `level`                     | `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`                     |
| `service`                   | Required service name, 1–128 bytes                                               |
| `message`                   | Required text, 1–16,384 bytes                                                    |
| `environment`, `request_id` | Optional text, 1–128 bytes                                                       |
| `trace_id`, `span_id`       | Optional nonzero hexadecimal IDs, 32/16 characters; span requires trace          |
| `attributes`                | Optional JSON object; up to 64 attributes and 16 KiB total                       |

Attributes preserve strings, numbers, booleans, null, objects, and arrays. Nesting is limited to four levels, arrays/objects to 64 entries, and keys to 128 bytes. Filterable top-level attributes use typed equality; numeric `200` differs from string `"200"`. The ingest app validates the whole batch before enqueueing it.

## OpenTelemetry

When investigating an event, **Logs for this request** and **Logs for this trace** open matching logs across the project. The log query accepts `request_id` as well as `trace_id`; both use exact equality.

Use an **OTLP/HTTP** logs exporter or collector with these settings:

```sh
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://highkey.example.com/api/logs/v1/logs
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $HIGHKEY_LOG_KEY"
OTEL_SERVICE_NAME=checkout-api
```

The endpoint accepts OTLP JSON (`application/json`) or Protobuf (`application/x-protobuf`), with optional gzip compression. Exporter-specific configuration may differ. Set its maximum batch size to 100 or fewer records and keep both encoded and decompressed request bodies within 256 KiB. Highkey rejects invalid batches atomically. Retriable overload responses, including ClickHouse being unavailable, use HTTP 503 and `Retry-After`.

Resource and record attributes are retained, with record attributes taking precedence. `service.name` supplies the service (falling back to `unknown_service`); `deployment.environment.name` or `deployment.environment` supplies the environment. Severity numbers map to six levels. Trace/span context is preserved. Structured bodies are rendered as JSON text. Timestamp falls back to observed time, then receipt time. A `log.record.uid` string supplies the deduplication ID; otherwise each export receives a generated ID, so exporter retries may create duplicates. OTLP/gRPC is not supported.

Log endpoints are intended for services and collectors. Browser CORS ingestion is only provided for the analytics endpoint. Review application data before sending it: Highkey does not automatically redact credentials, personal data, or message content.

## Explore logs

Open **Logs** from a project's sidebar. Search literal message text, narrow by severity/service, or open Filters for environment, trace ID, and typed attribute equality. Applied queries are shareable URLs; drafts stay local until **Search**. Select a row for context, attributes, and raw JSON; select a scalar attribute to filter by it.

The volume chart shows matching records and errors over the selected window; drag across it to zoom the query to those buckets. **Following** checks every five seconds while visible and online, retaining an open inspector. Scrolling pauses Follow and freezes the interval while older 100-record cursor batches load near the bottom. The virtualized viewport renders only nearby records and buffers at most 10,000. At that limit the footer suggests narrowing the time range or search. Locally appended batches and scroll position are not persisted. **Back to newest** clears the buffer and resumes Follow. Use arrow keys, Home/End, and Page Up/Down to move through loaded records, and Enter to inspect. Older pages use a `(timestamp, log_id)` cursor. Windows are 15 minutes, 1/6/24 hours, or seven days. The query accepts positive ranges up to 31 days.

### Saved log views and dashboards

**Save view** names the current filters and time window (15m, 1h, 6h, 24h or 7d) and lists it under Logs in the sidebar; agents can also read and write them over MCP. A view stores `level` or `min_level`, `service`, `environment`, `source_id`, `search` and attribute filters, not a trace ID or a selected range. See [saved views](dashboards.md#saved-views). Dashboard widgets can query logs too (`"signal": "logs"`, with `level`/`min_level`, `service`, `environment`, `search` and attribute filters), limited to the newest 31 days; see [custom dashboards](dashboards.md#queries).

## Management API

The dashboard serves these paths, to a signed-in session or an API key; log keys and settings need a member, admin or owner (see [access](access.md)).

| Method      | Path                                 | Body/result                                                        |
| ----------- | ------------------------------------ | ------------------------------------------------------------------ |
| GET / PATCH | `/api/products/:id/logs/settings`    | `{ "retention_days": 7 }`, range 1–365                             |
| GET / POST  | `/api/products/:id/logs/keys`        | Metadata / create `{ "label": "API", "source_id": "SOURCE_UUID" }` |
| DELETE      | `/api/products/:id/logs/keys/:keyId` | Revoke this project's key                                          |
| POST        | `/api/products/:id/logs/query`       | Query below                                                        |

Like event keys, log keys reach the ingest app through ClickHouse's key registry: a revoked key stops working within 5 seconds. See [keys and retention at the ingest app](api.md#keys-and-retention-at-the-ingest-app).

```json
{
  "from": "2026-11-13T00:00:00Z",
  "to": "2026-11-14T00:00:00Z",
  "level": "error",
  "service": "checkout-api",
  "filters": [{ "attribute": "status", "value": 500 }]
}
```

Optional fields are `source_id`, `level` (an exact level) or `min_level` (that level and every more severe one; not both), `service`, `environment`, `search` (literal case-insensitive message substring, up to 512 bytes), `trace_id`, up to eight `filters`, and `cursor`. The response includes `logs`, `total`, `series`, `services`, `facets`, and `next_cursor`. On the first page (no `cursor`), `facets` lists the `services` and `environments` seen in the window for the requested source, independent of the other filters, plus up to 100 top-level `attributes` from the newest 1,000 records, each with the scalar `type` (`string`, `number`, or `boolean`) its values usually have; nested objects and arrays are omitted because filters match scalars. Cursor pages return `facets: null`. Pass `next_cursor` unchanged as `cursor` with the same query to fetch the next 100 rows. Response timestamps and cursors use epoch milliseconds. The count/histogram cover all matches independently of the page cursor. The histogram, service choices and records are separate ClickHouse queries, so a record stored between them can appear in one and not another.

## Retention and capacity

Logs default to **seven days** independently of event retention. Settings accepts 1–365 days. Each record expires at its timestamp plus the log retention, and ClickHouse's TTL deletes expired records during background merges, not at the moment they expire. Changing log retention rewrites the expiry of the project's stored logs, so shortening it removes older logs at the next TTL merge. `POST /api/cleanup` forces that merge for events and logs and returns `logs_removed` alongside analytics `removed`. Deleting rows does not promise immediate disk-space reduction.

Log ingestion has its own bounds in the ingest app: 16 concurrent uploads and 16 requests waiting for a write. Requests for the same project are written one batch at a time, and new requests collect into the next batch while one is in flight; each request gets its own accepted/duplicate counts only after ClickHouse has stored the batch. Overload returns 503; clients should retry with backoff and stable IDs. These bounds and retention are not a disk quota or per-key fairness mechanism.

Log queries run as the project's ClickHouse user, under the same per-project limits as event queries (see [capacity and limits](api.md#capacity-and-limits)). Search is a case-insensitive substring match; an n-gram index over the lowercased message lets ClickHouse skip blocks that cannot match. There is no arbitrary SQL, saved search, alerting, or production log-volume capacity claim. See [access configuration](access.md) and [deployment/backups](../README.md#deployment) before upgrading.

## Run the ingest app on its own

The ingest app is one binary that needs only ClickHouse. Build it and point it at a migrated server:

```sh
cargo build --locked --release -p highkey-ingest
HIGHKEY_CLICKHOUSE_URL=http://127.0.0.1:8123 \
HIGHKEY_INGEST_CLICKHOUSE_PASSWORD="$HIGHKEY_INGEST_CLICKHOUSE_PASSWORD" \
HIGHKEY_TRACKER_PATH=sdk/typescript/dist/tracker.js \
./target/release/highkey-ingest
```

It signs in as `highkey_ingest` (`HIGHKEY_CLICKHOUSE_USER` overrides it), listens on `HIGHKEY_BIND` (default `127.0.0.1:3001`), and refuses to start against a ClickHouse older than 25.8 or a schema older than it needs (run `bun run migrate` first). `bun scripts/clickhouse.ts dev-up` starts and migrates a local server; `bun run build:sdk` builds the tracker bundle. During development, `cargo run -p highkey-ingest` builds and starts it in one step with the same variables, and `bun run dev:standalone` runs it beside the dashboard.

## Measure a logging workload

```sh
bun benchmark:logs
```

The log benchmark builds the release ingest app, starts a ClickHouse of its own (in memory, capped at 4 GiB; `BENCH_CLICKHOUSE_MEMORY` changes the cap) and serves the dashboard's API from Bun. It creates two disposable projects, preloads 100,000 logs over six days and 64 services, then runs four ingestion workers alongside two log-search workers for 15 seconds, with every tenth batch retried to check deduplication. It verifies the final stored count and removes everything afterward. Use `BENCH_PRELOAD`, `BENCH_SECONDS`, `BENCH_BATCH_SIZE` (1–100), `BENCH_PORT` and `BENCH_OUTPUT` to adjust the run. It needs Docker. See [the benchmark report](benchmark.md#logs-ingestion-while-log-searches-run) for measured results and their limits; this is a closed-loop localhost workload, not a production capacity limit.
