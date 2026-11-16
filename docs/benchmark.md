# Benchmarks

Measured on **16 November 2026** with the ingest app and the dashboard on ClickHouse. Raw results are in [benchmark-results.json](benchmark-results.json) (events) and [benchmark-logs-results.json](benchmark-logs-results.json) (logs). These are local observations on one laptop, not a production capacity guarantee.

## Reproduce

```sh
bun install --frozen-lockfile
bun benchmark
bun benchmark:logs
bun run test:load
# Optional larger/longer runs:
BENCH_SECONDS=60 BENCH_PRELOAD=100000 BENCH_OUTPUT=docs/my-benchmark.json bun benchmark
```

Each script builds the release ingest app (`cargo build --locked --release -p piko-ingest`), starts a ClickHouse container of its own (tmpfs, capped at 4 GiB; `BENCH_CLICKHOUSE_MEMORY` changes the cap) on a loopback port, serves the dashboard's API from Bun on another, and removes everything afterward. No running workspace is touched. They need Docker and `ps`. Run them after builds and other load finishes, for comparable results.

## Hardware

- Apple M1 Pro, 10 logical CPUs, 16 GiB RAM; macOS (darwin 27.2.0), arm64. Docker Desktop runs ClickHouse in its VM.
- Rust 1.95.0, Bun 1.4.4, `clickhouse/clickhouse-server:26.8.37.168`; release build, loopback HTTP, no TLS or proxy.

## Events: ingestion while Explore queries run

- Two projects. 10,000 events preloaded over 30 days, with string, boolean and numeric properties and 1,000 possible actors per project.
- Four ingestion workers send 100-event batches to the ingest app, closed loop. Every tenth batch is sent again with the same IDs.
- Two query workers run Explore queries through the dashboard's API: one counts website events grouped by path, the other averages a numeric property of the tool's successful commands, grouped by command. Each query computes the summary, the daily buckets, the top groups, the matching count, the event names and a 25-event page.
- 15 s (15.08 s with the final requests drained). Latencies are measured at the HTTP client; the retried batches add load but are not in the ingestion latency samples.

| Metric                                           |                Observed |
| ------------------------------------------------ | ----------------------: |
| Newly committed events                           |                  88,000 |
| Duplicate events acknowledged without insertion  |                   8,800 |
| Verified stored events (preload + new)           |                  98,000 |
| Committed event throughput                       |               5,834/sec |
| Successful Explore queries                       |                     408 |
| Explore query throughput                         |                27.0/sec |
| Ingestion request p50 / p95 / p99                |   65.4 / 75.4 / 80.9 ms |
| Query request p50 / p95 / p99                    | 72.5 / 100.2 / 107.1 ms |
| Ingest app RSS after preload / peak              |         16.9 / 19.3 MiB |
| ClickHouse container memory after preload / peak |           271 / 888 MiB |
| Request failures                                 |                       0 |

The script counts both projects through Explore afterward and fails unless the total equals the preload plus the acknowledged new events, so the 8,800 retried IDs did not inflate stored counts.

**Reading the ingestion numbers.** An ingestion request is acknowledged only after ClickHouse commits it. The ingest app sends asynchronous inserts that ClickHouse flushes within 10–50 ms (the `piko_ingest` settings profile), and the request waits for that flush. Four closed-loop workers therefore cap this run near 4 × 100 events per ~65 ms ≈ 6,000 events per second: the figure measures the commit wait, not ClickHouse's capacity. More concurrent clients, or larger batches, raise throughput without raising latency much, because requests that arrive together share a flush.

## Logs: ingestion while log searches run

- Two projects with a log key each. 100,000 logs preloaded with timestamps over six days, out of order, across 64 services.
- Four workers send 100-log batches to the ingest app; every tenth batch is sent again. Two workers search the Logs page through the dashboard's API, with message text and typed attribute filters.
- 15 s (15.11 s with the final requests drained).

| Metric                                           |                 Observed |
| ------------------------------------------------ | -----------------------: |
| Newly committed logs                             |                   75,800 |
| Duplicate logs acknowledged                      |                    7,400 |
| Verified stored logs                             |                  175,800 |
| Committed log throughput                         |                5,018/sec |
| Successful log searches                          |                      272 |
| Log search throughput                            |                 18.0/sec |
| Ingestion request p50 / p95 / p99                |    75.3 / 87.1 / 90.7 ms |
| Search request p50 / p95 / p99                   | 111.1 / 134.1 / 141.5 ms |
| Ingest app RSS after preload / peak              |          17.0 / 19.1 MiB |
| ClickHouse container memory after preload / peak |            586 / 890 MiB |
| Request failures                                 |                        0 |

The same commit wait sets the ingestion figures.

## The load test: does ingestion stay fast under dashboard load?

`bun run test:load` is the check that decides it. It preloads **10 million events** over 30 days into one of two projects, runs 30 s of ingestion alone (four workers, 100-event batches, every tenth retried), then the same ingestion while eight readers loop over the Overview widgets and an unbounded `SELECT count(), uniqExact(actor_id) FROM all_events`. It fails if any ingestion request fails, if the loaded p99 is more than twice the unloaded p99, or if the loaded p99 reaches 250 ms.

Two runs on the hardware above:

| Run | Ingestion alone p50 / p95 / p99 | With eight readers p50 / p95 / p99 |
| --- | ------------------------------- | ---------------------------------- |
| 1   | 67.2 / 117.1 / 154.7 ms         | 83.7 / 109.8 / 146.7 ms            |
| 2   | 70.9 / 153.3 / 161.6 ms         | 84.7 / 108.8 / 138.0 ms            |

Both passed with no failed ingestion request. Three things keep the readers from slowing ingestion:

- **ClickHouse workloads.** The ingest app's queries and inserts run in the `piko_ingest` workload, which gets released CPU slots first; every project reader runs in `piko_readers`, which may use at most half the cores (`clickhouse/migrations/0002_ingest_priority.sql`).
- **Reader limits.** The `piko_reader` profile caps each query at 2 threads, 1 GiB, 10 s and 4 concurrent queries per project.
- **The dashboard's gates.** Widget runs wait at in-process concurrency gates and never take the last query slot.

Under that load, about half of the readers' runs were refused: by the dashboard's per-project limit ("Too many queries for this project") or ClickHouse's 4 concurrent queries per project. That is the intended trade: one project's dashboards cannot take the server from ingestion or from other projects. Without the workloads and the 10–50 ms flush, the first run measured 210 ms p99 alone and 486 ms p99 under load, and failed.

## Interpretation and limits

These are short runs on one laptop with ClickHouse on tmpfs in Docker's VM, so disk is not measured: on a server with SSDs, `fsync_after_insert` adds disk latency to every commit. Network, TLS, Cloudflare, Tako's proxy and channels are excluded. Memory is sampled once a second and may miss short peaks. One ClickHouse node shares CPU and disk between reads and writes; the workloads and caps bound the interference, they do not remove it. Controlled overload (full queues, unreachable ClickHouse) has its own correctness tests in `apps/ingest`.

## Earlier measurements

Before November 2026 Piko stored each project's events in its own DuckDB file, inside one Rust API. Those runs (1 November 2026: 15,142 events/sec with 23.5 / 28.3 / 35.0 ms ingestion; 13 November 2026 for logs) acknowledged a commit to a local file, not to a separate database, and are not comparable with the figures above. The raw results of the last DuckDB runs remain in [benchmark-sources-results.json](benchmark-sources-results.json) (events, 1 November) and [benchmark-logs-before-results.json](benchmark-logs-before-results.json) (logs); older files are in the repository's history.
