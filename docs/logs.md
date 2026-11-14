# Application logs

Each project stores application logs in `logs/<project-id>.duckdb`, separate from analytics in `products/`. Both live inside the API data directory and belong in stopped-API backups. SQLite stores log key hashes and retention settings. Existing event files and ingestion keys keep their behavior.

## Connect a service

Open **Settings → Logs**, select a source, and create a log ingestion key. The `pl_` secret is shown once. Keep it in your service or collector configuration. These keys only write logs to their own project and source; analytics keys cannot send logs, and log keys cannot send analytics or read data.

Send structured JSON to the dashboard's ingestion endpoint:

```sh
curl --fail-with-body https://piko.example.com/api/logs/ingest \
  -H "Authorization: Bearer $PIKO_LOG_KEY" \
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

The response is `{"accepted":1,"duplicates":0}` after the transaction commits. Retrying the same project-scoped `log_id` returns a duplicate instead of adding another row. Deduplication ends when the log expires. A single record object also works. If `log_id` or `timestamp` is omitted, the API generates an ID or uses receipt time; supply stable IDs for retry deduplication.

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

Attributes preserve strings, numbers, booleans, null, objects, and arrays. Nesting is limited to four levels, arrays/objects to 64 entries, and keys to 128 bytes. Filterable top-level attributes use typed equality; numeric `200` differs from string `"200"`. The API validates the whole batch before enqueueing it.

## OpenTelemetry

Use an **OTLP/HTTP** logs exporter or collector with these settings:

```sh
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://piko.example.com/api/logs/v1/logs
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $PIKO_LOG_KEY"
OTEL_SERVICE_NAME=checkout-api
```

The endpoint accepts OTLP JSON (`application/json`) or Protobuf (`application/x-protobuf`), with optional gzip compression. Exporter-specific configuration may differ. Set its maximum batch size to 100 or fewer records and keep both encoded and decompressed request bodies within 256 KiB. Piko rejects invalid batches atomically. Retriable overload responses use HTTP 503 and `Retry-After`.

Resource and record attributes are retained, with record attributes taking precedence. `service.name` supplies the service (falling back to `unknown_service`); `deployment.environment.name` or `deployment.environment` supplies the environment. Severity numbers map to six levels. Trace/span context is preserved. Structured bodies are rendered as JSON text. Timestamp falls back to observed time, then receipt time. A `log.record.uid` string supplies the deduplication ID; otherwise each export receives a generated ID, so exporter retries may create duplicates. OTLP/gRPC is not supported.

Log endpoints are intended for services and collectors. Browser CORS ingestion is only provided for the existing analytics endpoint. Review application data before sending it: Piko does not automatically redact credentials, personal data, or message content.

## Explore logs

Open **Logs** from a project's sidebar. Search literal message text, narrow by severity/service, or open Filters for environment, trace ID, and typed attribute equality. Applied queries are shareable URLs; drafts stay local until **Search**. Select a row for context, attributes, and raw JSON; select a scalar attribute to filter by it.

The volume chart shows matching records and errors over the selected window; drag across it to zoom the query to those buckets. **Following** checks every five seconds while visible and online, retaining an open inspector. Scrolling pauses Follow and freezes the interval while older 100-record cursor batches load near the bottom. The virtualized viewport renders only nearby records and buffers at most 10,000. At that limit the footer suggests narrowing the time range or search. Locally appended batches and scroll position are not persisted. **Back to newest** clears the buffer and resumes Follow. Use arrow keys, Home/End, and Page Up/Down to move through loaded records, and Enter to inspect. Older pages use a `(timestamp, log_id)` cursor. Windows are 15 minutes, 1/6/24 hours, or seven days. The API supports positive ranges up to 31 days.

### Saved log views and dashboards

**Save view** names the current filters and time window (15m, 1h, 6h, 24h or 7d) and lists it under Logs in the sidebar; agents can also read and write them over MCP. A view stores `level` or `min_level`, `service`, `environment`, `source_id`, `search` and attribute filters, not a trace ID or a selected range. See [saved views](dashboards.md#saved-views). Dashboard widgets can query logs too (`"signal": "logs"`, with the same `level`/`min_level`, `service`, `environment`, `search` and attribute filters, plus a `count` or numeric `attribute` measure), limited to the newest 31 days; see [custom dashboards](dashboards.md).

## Management API

Management requests stay behind Cloudflare Access. Mutations also require the existing `X-Piko-Admin: 1` CSRF marker.

| Method      | Path                                 | Body/result                                                        |
| ----------- | ------------------------------------ | ------------------------------------------------------------------ |
| GET / PATCH | `/api/products/:id/logs/settings`    | `{ "retention_days": 7 }`, range 1–365                             |
| GET / POST  | `/api/products/:id/logs/keys`        | Metadata / create `{ "label": "API", "source_id": "SOURCE_UUID" }` |
| DELETE      | `/api/products/:id/logs/keys/:keyId` | Revoke this project's key                                          |
| POST        | `/api/products/:id/logs/query`       | Query below                                                        |

```json
{
  "from": "2026-11-13T00:00:00Z",
  "to": "2026-11-14T00:00:00Z",
  "level": "error",
  "service": "checkout-api",
  "filters": [{ "attribute": "status", "value": 500 }]
}
```

Optional fields are `source_id`, `level` (an exact level) or `min_level` (that level and every more severe one; not both), `service`, `environment`, `search` (literal case-insensitive message substring, up to 512 bytes), `trace_id`, up to eight `filters`, and `cursor`. The response includes `logs`, `total`, `series`, `services`, `facets`, and `next_cursor`. On the first page (no `cursor`), `facets` lists the `services` and `environments` seen in the window for the requested source, independent of the other filters, plus up to 100 top-level `attributes` from the newest 1,000 records, each with the scalar `type` (`string`, `number`, or `boolean`) its values usually have; nested objects and arrays are omitted because filters match scalars. Cursor pages return `facets: null`. Pass `next_cursor` unchanged as `cursor` with the same query to fetch the next 100 rows. Response timestamps and cursors use epoch milliseconds. Counts, histogram, service choices, and records share a database snapshot; the count/histogram cover all matches independently of the page cursor.

## Retention and capacity

Logs default to **seven days** independently of event retention. Settings accepts 1–365 days. Hourly cleanup removes expired logs based on event time; `/api/cleanup` performs the same cleanup and adds `logs_removed` alongside analytics `removed`. Reducing retention can delete older logs at the next cleanup. Deleting rows does not promise immediate file-size reduction.

The log writer has a separate bounded queue (16 requests), separate ingestion admission (16), and two concurrent query slots. At most four log database instances remain open, each with a 32 MB DuckDB buffer limit. Blocking database work runs off Tokio workers. Overload returns 503; clients should retry with backoff and stable IDs. These bounds and retention are not a disk quota or per-key fairness mechanism.

The writer drains up to 16 already-queued requests without adding a batching delay. Requests for the same project share one bulk append and commit, with individual accepted/duplicate counts returned only after commit. Cleanup and shutdown preserve queue order. Log queries compute histogram and service summaries together, derive the total from the histogram, and read the cursor page separately within the same snapshot.

Search uses parameterized scans, with no full-text index, arbitrary SQL, saved searches, alerting, or production log-volume capacity claim. Run one API process per data directory. See [access configuration](access.md) and [deployment/backups](../README.md#deployment) before upgrading.

### Measure a logging workload

Build the release API and run the isolated log benchmark:

```sh
cargo build --release -p piko
bun benchmark:logs
```

The harness creates two disposable projects, preloads 100,000 logs, then runs four ingestion workers alongside two query workers for 15 seconds. Records span six days and 64 services; queries alternate between all records, case-insensitive message substrings, and typed JSON filters. Every tenth batch is retried to check deduplication. The report verifies the final committed count and includes request errors, ingestion/query latency percentiles, throughput, and sampled API RSS. It removes its temporary databases after shutdown and refuses an occupied port before sending requests.

Use `BENCH_PRELOAD`, `BENCH_SECONDS`, `BENCH_BATCH_SIZE` (1–100), `BENCH_PORT`, and `BENCH_OUTPUT` to adjust the run. `BENCH_BINARY` selects an independently built release API for before/after comparisons. This is a closed-loop localhost workload; it does not establish a production capacity limit or exercise retention cleanup and collectors.

The 13 November 2026 comparison on an Apple M1 Pro (10 logical CPUs, 16 GiB RAM, macOS arm64) used the default workload above with Bun 1.4.4 and a release API. [Before](benchmark-logs-before-results.json) used one commit per request and four query statements; [after](benchmark-logs-results.json) uses queued-request batching and two query statements.

| Measurement                 |    Before |     After |
| --------------------------- | --------: | --------: |
| Newly committed logs/second |    12,300 |    20,398 |
| Successful queries/second   |      60.9 |      68.9 |
| Ingestion p95               |   40.8 ms |   24.9 ms |
| Query p95                   |   58.6 ms |   51.2 ms |
| Sampled peak API RSS        | 190.1 MiB | 174.6 MiB |

Both runs reported zero request errors and exact final counts: 284,900 stored logs before and 407,000 after, including the 100,000-record preload. Each run is a single 15-second observation on a development host. The dataset grows during measurement, so the faster ingestion run also queries more records. These results support the combined optimization for this workload; they do not isolate each change's contribution, establish a universal speedup, or measure sustained disk growth and many-project cache pressure.
