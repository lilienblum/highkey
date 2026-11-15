// Shared helpers for dashboard server tests: a fresh SQLite store per context, the shared test
// ClickHouse, and direct inserts of events and logs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiContext, Signal } from "../src/server/api/context";
import { handleApi } from "../src/server/api/router";
import { Readers } from "../src/server/clickhouse/access";
import { gatesFromEnv } from "../src/server/dashboards/gates";
import { WriteLimit } from "../src/server/dashboards/limit";
import { ClickHouse } from "../src/server/clickhouse/client";
import { migrate } from "../src/server/clickhouse/migrate";
import { Store } from "../src/server/db/sqlite";
import { testClickHouse } from "./clickhouse";

export interface TestContext extends ApiContext {
  signals: { product: string; signal: Signal }[];
  cleanup(): void;
}

let migrated: Promise<unknown> | undefined;

export async function testAdmin(): Promise<ClickHouse> {
  const server = await testClickHouse();
  const admin = new ClickHouse({ url: server.url, user: server.user, password: server.password });
  migrated ??= migrate(admin, { ingestPassword: "piko-ingest-test" });
  await migrated;
  return admin;
}

export async function testContext(options: { corsOrigins?: string[] } = {}): Promise<TestContext> {
  const server = await testClickHouse();
  const admin = await testAdmin();
  const dir = mkdtempSync(join(tmpdir(), "piko-dashboard-test-"));
  const store = Store.open(join(dir, "state.sqlite"));
  const secret = "dashboard-test-secret";
  const signals: { product: string; signal: Signal }[] = [];
  return {
    store,
    admin,
    readers: new Readers({ url: server.url, secret }),
    secret,
    corsOrigins: options.corsOrigins ?? [],
    changes: { notify: (product, signal) => void signals.push({ product, signal }) },
    // Tests write freely; the rate-limit test installs the real limit.
    writeLimit: new WriteLimit(1_000_000),
    gates: gatesFromEnv({ PIKO_QUERY_CONCURRENCY: "4" }),
    now: () => new Date(),
    signals,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
  json: any;
  headers: Headers;
  bytes: Uint8Array;
}

export async function call(
  ctx: ApiContext,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", "x-piko-admin": "1", ...headers },
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD")
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await handleApi(new Request(`http://piko.test${path}`, init), ctx);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {}
  return { status: response.status, json, headers: response.headers, bytes };
}

/** A project created through the API. */
export async function project(ctx: ApiContext, name = "Test project", retention = 30) {
  const reply = await call(ctx, "POST", "/api/products", { name, retention_days: retention });
  if (reply.status !== 200) throw new Error(`create project: ${JSON.stringify(reply.json)}`);
  return reply.json as { id: string; slug: string; sources: { id: string }[] };
}

const stamp = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "");

export interface EventRow {
  event_id: string;
  name?: string;
  source?: string;
  source_id?: string;
  time?: Date;
  actor_id?: string | null;
  identity_kind?: string | null;
  session_id?: string | null;
  properties?: Record<string, unknown>;
}

export async function seedEvents(productId: string, rows: EventRow[]): Promise<void> {
  const admin = await testAdmin();
  const now = new Date();
  await admin.insert(
    "piko.events",
    rows.map((row) => ({
      product_id: productId,
      source_id: row.source_id ?? productId,
      event_id: row.event_id,
      name: row.name ?? "page_view",
      source: row.source ?? "web",
      event_time: stamp(row.time ?? now),
      received_at: stamp(now),
      actor_id: row.actor_id ?? null,
      identity_kind: row.identity_kind ?? null,
      session_id: row.session_id ?? null,
      properties: row.properties ?? {},
      expires_at: stamp(new Date(now.getTime() + 400 * 86_400_000)).slice(0, 19),
    })),
    { settings: { json_type_escape_dots_in_keys: 1 } },
  );
}

export interface LogRow {
  log_id: string;
  time?: Date;
  level?: string;
  message?: string;
  service?: string;
  source_id?: string;
  environment?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  request_id?: string | null;
  attributes?: Record<string, unknown>;
}

export async function seedLogs(productId: string, rows: LogRow[]): Promise<void> {
  const admin = await testAdmin();
  const now = new Date();
  await admin.insert(
    "piko.logs",
    rows.map((row) => ({
      product_id: productId,
      source_id: row.source_id ?? productId,
      log_id: row.log_id,
      timestamp: stamp(row.time ?? now),
      received_at: stamp(now),
      level: row.level ?? "info",
      message: row.message ?? "ok",
      service: row.service ?? "api",
      environment: row.environment ?? null,
      trace_id: row.trace_id ?? null,
      span_id: row.span_id ?? null,
      request_id: row.request_id ?? null,
      attributes: row.attributes ?? {},
      expires_at: stamp(new Date(now.getTime() + 400 * 86_400_000)).slice(0, 19),
    })),
    { settings: { json_type_escape_dots_in_keys: 1 } },
  );
}
