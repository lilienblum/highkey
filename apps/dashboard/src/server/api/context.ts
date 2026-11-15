// What every API handler works with: the SQLite store, ClickHouse as admin and as each
// project's reader, and the live-update bus.
import { tako } from "tako.sh";
import { Readers } from "../clickhouse/access";
import { ClickHouse } from "../clickhouse/client";
import { Store } from "../db/sqlite";

export type Signal = "events" | "logs" | "dashboards";

export interface ChangeBus {
  notify(productId: string, signal: Signal): void;
}

export interface ApiContext {
  store: Store;
  admin: ClickHouse;
  readers: Readers;
  /** Derives each project's ClickHouse reader password. */
  secret: string;
  /** Extra origins allowed to call /api/read cross-origin (`*` allows any). */
  corsOrigins: string[];
  changes: ChangeBus;
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
  const dataDir = process.env.PIKO_DATA_DIR ?? process.env.TAKO_DATA_DIR ?? "data";
  const url = process.env.PIKO_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
  const password = secret("PIKO_CLICKHOUSE_PASSWORD") ?? "";
  const readerSecret = secret("PIKO_READER_SECRET") ?? password;
  singleton = {
    store: Store.open(`${dataDir}/state.sqlite`),
    admin: new ClickHouse({
      url,
      user: process.env.PIKO_CLICKHOUSE_USER ?? "piko_admin",
      password,
    }),
    readers: new Readers({ url, secret: readerSecret }),
    secret: readerSecret,
    corsOrigins: parseOrigins(process.env.PIKO_CORS_ORIGINS),
    changes: { notify: () => {} },
    now: () => new Date(),
  };
  return singleton;
}

/** Replaces the process's change bus, once live updates are available. */
export function setChangeBus(bus: ChangeBus): void {
  apiContext().changes = bus;
}
