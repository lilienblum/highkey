// What every API handler works with: the management database, ClickHouse as admin and as each
// project's reader, and the live-update bus.
import { tako } from "tako.sh";
import { Readers } from "../clickhouse/access";
import { ClickHouse } from "../clickhouse/client";
import { type Gates, gatesFromEnv } from "../dashboards/gates";
import { WriteLimit } from "../dashboards/limit";
import type { Db } from "../db/db";
import { lazyDb, openDb } from "../db/open";

export type Signal = "events" | "logs" | "dashboards";

export interface ChangeBus {
  notify(productId: string, signal: Signal): void;
}

export interface ApiContext {
  /** The management database: the Tako database bound as `main`, or a local file without Tako. */
  db: Db;
  admin: ClickHouse;
  readers: Readers;
  /** Derives each project's ClickHouse reader password. */
  secret: string;
  /** Extra origins allowed to call /api/read cross-origin (`*` allows any). */
  corsOrigins: string[];
  changes: ChangeBus;
  /** Dashboard and view writes per project per minute. */
  writeLimit: WriteLimit;
  /** Concurrency gates for dashboard widget runs. */
  gates: Gates;
  now(): Date;
}

export function parseOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function secret(name: string): string | undefined {
  const fromTako = (tako.secrets as Record<string, string | undefined>)[name];
  return fromTako ?? process.env[name];
}

let singleton: ApiContext | undefined;

/** The process's context, built once from the environment. */
export function apiContext(): ApiContext {
  if (singleton) return singleton;
  const url = process.env.HIGHKEY_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
  const password = secret("HIGHKEY_CLICKHOUSE_PASSWORD") ?? "";
  const readerSecret = secret("HIGHKEY_READER_SECRET") ?? password;
  singleton = {
    db: lazyDb(openDb),
    admin: new ClickHouse({
      url,
      user: process.env.HIGHKEY_CLICKHOUSE_USER ?? "highkey_admin",
      password,
    }),
    readers: new Readers({ url, secret: readerSecret }),
    secret: readerSecret,
    corsOrigins: parseOrigins(process.env.HIGHKEY_CORS_ORIGINS),
    changes: { notify: () => {} },
    writeLimit: new WriteLimit(),
    gates: gatesFromEnv(),
    now: () => new Date(),
  };
  return singleton;
}

/** Replaces the process's change bus, once live updates are available. */
export function setChangeBus(bus: ChangeBus): void {
  apiContext().changes = bus;
}
