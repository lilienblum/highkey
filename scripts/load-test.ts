// The deciding load test: does ingestion stay fast while dashboards run heavy queries?
//
//   bun run test:load
//
// It starts its own ClickHouse (4 GB, tmpfs), provisions two projects through the dashboard's own
// operations, preloads 10 million events over 30 days into the first, and runs the release
// ingest binary. Phase 1 is 30 s of ingestion alone: four workers send 100-event batches, and
// every tenth batch is sent again, as a client retry. Phase 2 repeats it while eight readers loop
// over the Overview widgets and an unbounded count over all history. It fails if any ingest
// request fails, if the phase 2 p99 is more than twice phase 1's, or if it reaches 250 ms.
import { openBunDb } from "../apps/dashboard/src/server/db/bun-db";
import { applyMigrations } from "../apps/dashboard/src/server/db/migrations";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overviewTemplate } from "../apps/dashboard/src/lib/dashboards";
import type { ApiContext } from "../apps/dashboard/src/server/api/context";
import { Readers } from "../apps/dashboard/src/server/clickhouse/access";
import { ClickHouse } from "../apps/dashboard/src/server/clickhouse/client";
import { gatesFromEnv } from "../apps/dashboard/src/server/dashboards/gates";
import { WriteLimit } from "../apps/dashboard/src/server/dashboards/limit";
import { runWidget } from "../apps/dashboard/src/server/dashboards/run";
import { createEventKey, createProject } from "../apps/dashboard/src/server/operations";
import { ADMIN_USER, type ServerOptions, startClickHouse, stopClickHouse } from "./clickhouse";

const LOAD_SERVER: ServerOptions = {
  name: "highkey-load-clickhouse",
  port: 18125,
  tmpfs: true,
  password: "highkey-load",
  ingestPassword: "highkey-ingest-load",
  memory: "4g",
};
const INGEST_PORT = 18301;
const PHASE_MS = Number(process.env.HIGHKEY_LOAD_PHASE_MS ?? 30_000);
const PRELOAD = Number(process.env.HIGHKEY_LOAD_PRELOAD ?? 10_000_000);
const DAY = 86_400_000;
const root = new URL("..", import.meta.url).pathname;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
}
const summary = (latencies: number[]) => {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    requests: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
};
const ms = (n: number) => `${n.toFixed(1)} ms`;

async function run(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
}

const directory = mkdtempSync(join(tmpdir(), "highkey-load-"));
let ingest: ReturnType<typeof Bun.spawn> | undefined;
let failed = false;
try {
  await stopClickHouse(LOAD_SERVER.name);
  const { url } = await startClickHouse(LOAD_SERVER);
  const admin = new ClickHouse({ url, user: ADMIN_USER, password: LOAD_SERVER.password });
  const ctx: ApiContext = {
    db: openBunDb(join(directory, "state.sqlite")),
    admin,
    readers: new Readers({ url, secret: LOAD_SERVER.password }),
    secret: LOAD_SERVER.password,
    corsOrigins: [],
    changes: { notify: () => {} },
    writeLimit: new WriteLimit(),
    gates: gatesFromEnv(),
    now: () => new Date(),
  };
  await applyMigrations(ctx.db);
  const busy = await createProject(ctx, { name: "Busy", retention_days: 365, website_url: null });
  const quiet = await createProject(ctx, { name: "Quiet", retention_days: 365, website_url: null });
  const keys = [
    (await createEventKey(ctx, busy.id, "Load", null, [])).key,
    (await createEventKey(ctx, quiet.id, "Load", null, [])).key,
  ];

  console.log(`Preloading ${PRELOAD.toLocaleString()} events over 30 days…`);
  const now = Date.now();
  const started = performance.now();
  await admin.command(
    `INSERT INTO highkey.events (product_id, source_id, event_id, name, source, event_time, received_at, actor_id, identity_kind, session_id, properties, expires_at) SELECT {p:UUID}, {p:UUID}, concat('preload-', toString(number)), ['page_view', 'signup', 'checkout_request'][number % 3 + 1], 'web', fromUnixTimestamp64Milli(toInt64({now:Int64} - (number * 7919) % {span:Int64}), 'UTC') AS at, at, concat('actor-', toString(number % 50000)), 'visitor', NULL, CAST('{"plan":"pro","path":"/"}' AS JSON), toDateTime({expires:Int64}, 'UTC') FROM numbers({rows:UInt64})`,
    {
      params: {
        p: busy.id,
        now,
        span: 30 * DAY,
        expires: Math.floor((now + 400 * DAY) / 1000),
        rows: PRELOAD,
      },
      settings: { async_insert: 0, max_insert_threads: 4 },
    },
  );
  console.log(`Preloaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);

  await run(["cargo", "build", "--locked", "--release", "-p", "highkey-ingest"]);
  ingest = Bun.spawn([`${root}target/release/highkey-ingest`], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HIGHKEY_BIND: `127.0.0.1:${INGEST_PORT}`,
      HIGHKEY_CLICKHOUSE_URL: url,
      HIGHKEY_CLICKHOUSE_USER: "highkey_ingest",
      HIGHKEY_CLICKHOUSE_PASSWORD: LOAD_SERVER.ingestPassword,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const endpoint = `http://127.0.0.1:${INGEST_PORT}`;
  for (let tries = 0; ; tries++) {
    const ok = await fetch(`${endpoint}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (tries > 100) throw new Error("The ingest app did not start");
    await Bun.sleep(100);
  }

  const failures: string[] = [];
  async function phase(name: string, withReaders: boolean) {
    const latencies: number[] = [];
    let readerRuns = 0;
    let readerErrors = 0;
    const reasons = new Map<string, number>();
    const refused = (error: unknown) => {
      readerErrors++;
      const body = (error as { body?: { code?: string } }).body;
      const reason = body?.code ?? (error instanceof Error ? error.message.slice(0, 80) : "error");
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    };
    const deadline = Date.now() + PHASE_MS;
    const send = async (key: string, body: string) => {
      const at = performance.now();
      const response = await fetch(`${endpoint}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
      });
      const text = await response.text();
      latencies.push(performance.now() - at);
      if (!response.ok) failures.push(`${name}: ${response.status} ${text}`);
      return response.ok ? (JSON.parse(text) as { accepted: number; duplicates: number }) : null;
    };
    const writer = async (worker: number) => {
      const key = keys[worker % 2] as string;
      for (let batch = 0; Date.now() < deadline; batch++) {
        const body = JSON.stringify({
          events: Array.from({ length: 100 }, (_, i) => ({
            event_id: crypto.randomUUID(),
            name: "page_view",
            source: "web",
            actor_id: `load-${(batch * 100 + i) % 1000}`,
            identity_kind: "visitor",
            properties: { path: `/page/${i % 20}`, worker },
          })),
        });
        const ack = await send(key, body);
        if (ack && ack.accepted + ack.duplicates !== 100)
          failures.push(`${name}: acknowledged ${ack.accepted + ack.duplicates} of 100`);
        if (batch % 10 === 9) {
          const again = await send(key, body);
          if (again && again.duplicates !== 100)
            failures.push(`${name}: a retried batch found ${again.duplicates} duplicates`);
        }
      }
    };
    const widgets = overviewTemplate("Overview").widgets;
    const reader = async () => {
      const heavy = await ctx.readers.reader(busy.id);
      while (Date.now() < deadline) {
        for (const widget of widgets) {
          if (Date.now() >= deadline) break;
          const to = new Date();
          try {
            await runWidget(ctx, busy.id, {
              widget,
              from: new Date(to.getTime() - 30 * DAY).toISOString(),
              to: to.toISOString(),
            });
            readerRuns++;
          } catch (error) {
            refused(error);
          }
        }
        try {
          await heavy.query("SELECT count(), uniqExact(actor_id) FROM all_events");
          readerRuns++;
        } catch (error) {
          refused(error);
        }
      }
    };
    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => writer(i)),
      ...(withReaders ? Array.from({ length: 8 }, () => reader()) : []),
    ]);
    const result = summary(latencies);
    console.log(
      `${name}: ${result.requests} ingest requests, p50 ${ms(result.p50)}, p95 ${ms(result.p95)}, p99 ${ms(result.p99)}${withReaders ? `; ${readerRuns} reader queries, ${readerErrors} refused or timed out (${[...reasons].map(([r, n]) => `${r}: ${n}`).join(", ")})` : ""}`,
    );
    return result;
  }

  const alone = await phase("Phase 1, ingestion alone", false);
  const loaded = await phase("Phase 2, ingestion with eight readers", true);
  if (failures.length) {
    failed = true;
    console.error(`${failures.length} ingest failures, first: ${failures[0]}`);
  }
  if (loaded.p99 > 2 * alone.p99) {
    failed = true;
    console.error(`Phase 2 p99 ${ms(loaded.p99)} is more than twice phase 1's ${ms(alone.p99)}`);
  }
  if (loaded.p99 >= 250) {
    failed = true;
    console.error(`Phase 2 p99 ${ms(loaded.p99)} is not under 250 ms`);
  }
  if (!failed) console.log("Load test passed: ingestion stays fast under dashboard load.");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  ingest?.kill();
  await ingest?.exited;
  await stopClickHouse(LOAD_SERVER.name).catch((error) => console.error(error));
  rmSync(directory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
