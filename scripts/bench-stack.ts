// The stack the benchmarks measure: a ClickHouse of its own (4 GB, tmpfs), the release ingest
// binary, and the dashboard's API served by Bun as in production. Nothing outside it is touched.
import { openBunDb } from "../apps/dashboard/src/server/db/bun-db";
import { applyMigrations } from "../apps/dashboard/src/server/db/migrations";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiContext } from "../apps/dashboard/src/server/api/context";
import { handleApi } from "../apps/dashboard/src/server/api/router";
import { Readers } from "../apps/dashboard/src/server/clickhouse/access";
import { ClickHouse } from "../apps/dashboard/src/server/clickhouse/client";
import { gatesFromEnv } from "../apps/dashboard/src/server/dashboards/gates";
import { WriteLimit } from "../apps/dashboard/src/server/dashboards/limit";
import {
  ADMIN_USER,
  CLICKHOUSE_IMAGE,
  type ServerOptions,
  startClickHouse,
  stopClickHouse,
} from "./clickhouse";

const root = new URL("..", import.meta.url).pathname;

export interface Stack {
  ctx: ApiContext;
  admin: ClickHouse;
  /** The dashboard's API, over HTTP. */
  dashboard: string;
  /** The ingest app. */
  ingest: string;
  ingestPid: number;
  clickhouse: { image: string; memory: string; container: string };
  stop(): Promise<void>;
}

export async function startStack(name: string, port: number, ingestPort: number): Promise<Stack> {
  const server: ServerOptions = {
    name,
    port,
    tmpfs: true,
    password: "highkey-bench",
    ingestPassword: "highkey-ingest-bench",
    memory: process.env.BENCH_CLICKHOUSE_MEMORY ?? "4g",
  };
  await stopClickHouse(name);
  const { url } = await startClickHouse(server);
  const admin = new ClickHouse({ url, user: ADMIN_USER, password: server.password });
  const directory = mkdtempSync(join(tmpdir(), "highkey-bench-"));
  const ctx: ApiContext = {
    db: openBunDb(join(directory, "state.sqlite")),
    admin,
    readers: new Readers({ url, secret: server.password }),
    secret: server.password,
    corsOrigins: [],
    changes: { notify: () => {} },
    writeLimit: new WriteLimit(),
    gates: gatesFromEnv(),
    now: () => new Date(),
  };
  await applyMigrations(ctx.db);
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handleApi(r, ctx) });
  const build = Bun.spawn(["cargo", "build", "--locked", "--release", "-p", "highkey-ingest"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("cargo build -p highkey-ingest failed");
  const ingest = Bun.spawn([`${root}target/release/highkey-ingest`], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HIGHKEY_BIND: `127.0.0.1:${ingestPort}`,
      HIGHKEY_CLICKHOUSE_URL: url,
      HIGHKEY_CLICKHOUSE_USER: "highkey_ingest",
      HIGHKEY_CLICKHOUSE_PASSWORD: server.ingestPassword,
      HIGHKEY_QUEUE_CAPACITY: process.env.HIGHKEY_QUEUE_CAPACITY ?? "64",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const endpoint = `http://127.0.0.1:${ingestPort}`;
  for (let tries = 0; ; tries++) {
    if (ingest.exitCode !== null) throw new Error("The ingest app exited during startup");
    const ok = await fetch(`${endpoint}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (tries > 100) throw new Error("The ingest app did not start");
    await Bun.sleep(100);
  }
  return {
    ctx,
    admin,
    dashboard: `http://127.0.0.1:${http.port}`,
    ingest: endpoint,
    ingestPid: ingest.pid,
    clickhouse: { image: CLICKHOUSE_IMAGE, memory: server.memory as string, container: name },
    async stop() {
      ingest.kill("SIGTERM");
      await ingest.exited;
      http.stop(true);
      await stopClickHouse(name).catch((error) => console.error(error));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Resident memory of a process, in bytes. */
export async function processRss(pid: number): Promise<number> {
  const child = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return Number(output.trim()) * 1024;
}

/** Samples a value every second until stopped, keeping the peak; one sample at a time. */
export function peakSampler(sample: () => Promise<number>) {
  let peak = 0;
  let running = true;
  const done = (async () => {
    while (running) {
      peak = Math.max(peak, await sample());
      await Bun.sleep(1000);
    }
  })();
  return {
    async stop(): Promise<number> {
      running = false;
      await done;
      return peak;
    },
  };
}

/**
 * Memory a container uses now, in bytes, as `docker stats` reports it. It takes about two seconds,
 * so it runs asynchronously: a blocking call would stall the load generators and the dashboard
 * API that share this process.
 */
export async function containerMemory(name: string): Promise<number> {
  const child = Bun.spawn(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", name], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  const match = /^([\d.]+)\s*([KMG]i?B)/.exec(output.trim());
  if (!match) return 0;
  const units: Record<string, number> = {
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
  };
  return Number(match[1]) * (units[match[2] as string] ?? 1);
}
