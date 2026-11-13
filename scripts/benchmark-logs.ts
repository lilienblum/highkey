import { mkdtemp, rm } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";

function setting(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
}
const seconds = setting("BENCH_SECONDS", 15, 3600);
const preload = setting("BENCH_PRELOAD", 100_000, 10_000_000);
const batchSize = setting("BENCH_BATCH_SIZE", 100, 100);
const port = setting("BENCH_PORT", 3198, 65535);
const reservation = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) });
await reservation.stop(true);
const directory = await mkdtemp(join(tmpdir(), "piko-log-bench-"));
const serverLog = Bun.file(join(directory, "server.log"));
const api = Bun.spawn([resolve(process.env.BENCH_BINARY ?? "target/release/piko")], {
  env: {
    ...process.env,
    TAKO_DATA_DIR: undefined,
    TAKO_BUILD: undefined,
    TAKO_BOOTSTRAP_DATA: undefined,
    PIKO_CHANGE_URL: undefined,
    PIKO_DATA_DIR: directory,
    PIKO_BIND: `127.0.0.1:${port}`,
  },
  stdout: serverLog,
  stderr: serverLog,
});
const endpoint = `http://127.0.0.1:${port}`;
const now = Date.now();
const range = {
  from: new Date(now - 7 * 86_400_000).toISOString(),
  to: new Date(now + 3_601_000).toISOString(),
};
type Ack = { accepted: number; duplicates: number };
type Result = { total: number; series: { count: number }[]; next_cursor: unknown };
const projects: { id: string; key: string }[] = [];
const times = { ingest: [] as number[], query: [] as number[] };
const errors: Record<string, number> = {};
let accepted = 0;
let duplicates = 0;
let baselineRss = 0;
let peakRss = 0;
let sampler: ReturnType<typeof setInterval> | undefined;
const rss = () =>
  Number(
    Bun.spawnSync(["ps", "-o", "rss=", "-p", String(api.pid)])
      .stdout.toString()
      .trim(),
  ) * 1024;
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
};
const latency = (values: number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
});
async function request<T>(path: string, body: unknown, key?: string): Promise<T> {
  const response = await fetch(`${endpoint}/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-piko-admin": "1",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
function records(worker: number, sequence: number, size = batchSize) {
  return Array.from({ length: size }, (_, i) => {
    const index = sequence * batchSize + i;
    const failed = index % 13 === 0;
    return {
      log_id: `bench-${worker}-${sequence}-${i}`,
      timestamp: new Date(now - (index % 8640) * 60_000).toISOString(),
      level: failed ? "error" : "info",
      service: `service-${index % 64}`,
      environment: "production",
      message: `${failed ? "Upstream timeout" : "Request completed"} GET /api/orders/${index} request_id=${worker}-${sequence}-${i} region=ap-northeast-1 version=1.4.2 duration_ms=${index % 1000}`,
      attributes: {
        status: failed ? 500 : 200,
        cached: index % 2 === 0,
        duration_ms: index % 1000,
      },
    };
  });
}
try {
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`API exited: ${await serverLog.text()}`);
    try {
      ready = (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })).ok;
      if (ready) break;
    } catch {}
    await Bun.sleep(50);
  }
  if (!ready) throw new Error(`API startup failed: ${await serverLog.text()}`);
  for (const name of ["Log benchmark A", "Log benchmark B"]) {
    const project = await request<{ id: string }>("/products", {
      name,
      retention_days: 7,
      initial_source: { name: "API" },
    });
    const { key } = await request<{ key: string }>(`/products/${project.id}/logs/keys`, {
      label: "Benchmark",
    });
    projects.push({ id: project.id, key });
  }
  for (let start = 0; start < preload; start += batchSize) {
    const project = projects[Math.floor(start / batchSize) % projects.length];
    const ack = await request<Ack>(
      "/logs/ingest",
      { logs: records(0, start / batchSize, Math.min(batchSize, preload - start)) },
      project.key,
    );
    if (ack.accepted !== Math.min(batchSize, preload - start) || ack.duplicates !== 0)
      throw new Error("Preload acknowledgment mismatch");
  }
  baselineRss = rss();
  peakRss = baselineRss;
  sampler = setInterval(() => {
    peakRss = Math.max(peakRss, rss());
  }, 250);
  const started = performance.now();
  const stopAt = started + seconds * 1000;
  const recordError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    errors[message] = (errors[message] ?? 0) + 1;
  };
  await Promise.all([
    ...Array.from({ length: 4 }, (_, worker) =>
      (async () => {
        let sequence = 0;
        const project = projects[worker % projects.length];
        while (performance.now() < stopAt) {
          const logs = records(worker + 1, sequence++);
          const begin = performance.now();
          try {
            const ack = await request<Ack>("/logs/ingest", { logs }, project.key);
            if (ack.accepted !== logs.length || ack.duplicates !== 0)
              throw new Error("Fresh-batch acknowledgment mismatch");
            accepted += ack.accepted;
            duplicates += ack.duplicates;
            times.ingest.push(performance.now() - begin);
            if (sequence % 10 === 0) {
              const retry = await request<Ack>("/logs/ingest", { logs }, project.key);
              accepted += retry.accepted;
              duplicates += retry.duplicates;
              if (retry.accepted !== 0 || retry.duplicates !== logs.length)
                throw new Error("Retry acknowledgment mismatch");
            }
          } catch (error) {
            recordError(error);
          }
        }
      })(),
    ),
    ...Array.from({ length: 2 }, (_, worker) =>
      (async () => {
        let sequence = 0;
        while (performance.now() < stopAt) {
          const begin = performance.now();
          try {
            const extra = [
              {},
              { search: "uPsTrEaM TiMeOuT" },
              { filters: [{ attribute: "status", value: 500 }] },
            ][sequence++ % 3];
            const result = await request<Result>(`/products/${projects[worker].id}/logs/query`, {
              ...range,
              ...extra,
            });
            if (result.series.reduce((sum, bucket) => sum + bucket.count, 0) !== result.total)
              throw new Error("Query histogram mismatch");
            times.query.push(performance.now() - begin);
          } catch (error) {
            recordError(error);
          }
        }
      })(),
    ),
  ]);
  const elapsed = (performance.now() - started) / 1000;
  let stored = 0;
  for (const project of projects) {
    const result = await request<Result>(`/products/${project.id}/logs/query`, range);
    stored += result.total;
  }
  if (stored !== preload + accepted)
    throw new Error(`Persisted count mismatch: ${stored} vs ${preload + accepted}`);
  const report = {
    measured_at: new Date().toISOString(),
    hardware: {
      cpu: cpus()[0]?.model,
      logical_cpus: cpus().length,
      memory_bytes: totalmem(),
      os: `${platform()} ${release()}`,
      architecture: process.arch,
    },
    runtime: {
      binary: process.env.BENCH_BINARY ?? "target/release/piko",
      bun: Bun.version,
      profile: "release",
      duckdb: "2.0.0 (duckdb-rs 1.20000.1)",
      log_query_slots: 2,
      log_queue_requests: 16,
      duckdb_threads: 1,
      duckdb_memory_limit_per_project: "32MB",
    },
    workload: {
      preload_logs: preload,
      projects: 2,
      batch_size: batchSize,
      ingest_workers: 4,
      query_workers: 2,
      requested_seconds: seconds,
      actual_seconds: elapsed,
      notes:
        "Closed-loop localhost HTTP; six-day out-of-order timestamps, 64 services, message substring and typed JSON filters. Includes request drain; retries every ten batches. Preload is excluded. No retention sweep, network transport, or production capacity claim.",
    },
    results: {
      accepted_logs: accepted,
      duplicate_logs: duplicates,
      verified_stored_logs: stored,
      logs_per_second: accepted / elapsed,
      successful_queries: times.query.length,
      queries_per_second: times.query.length / elapsed,
      ingestion_ms: latency(times.ingest),
      query_ms: latency(times.query),
      baseline_rss_bytes: baselineRss,
      peak_rss_bytes: peakRss,
      errors,
    },
  };
  await Bun.write(
    process.env.BENCH_OUTPUT ?? "docs/benchmark-logs-results.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (Object.keys(errors).length)
    throw new Error("Benchmark requests failed; inspect report errors");
} finally {
  if (sampler) clearInterval(sampler);
  api.kill("SIGTERM");
  await api.exited;
  await rm(directory, { recursive: true, force: true });
}
