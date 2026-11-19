// Opens the management database: the Tako database bound as `main` when Tako serves one (Tako
// applies `migrations/` itself), otherwise a bun:sqlite file in the data directory, migrated here.
import { tako } from "tako.sh";
import { type BunDb, openBunDb } from "./bun-db";
import type { Db } from "./db";
import { openLibsqlDb } from "./libsql-db";
import { applyMigrations } from "./migrations";

/** The `main` binding's connection, when Tako provides one. */
export function takoDatabase(): { url: string; authToken: string } | null {
  try {
    const binding = (
      tako.databases as Record<string, { url: string; authToken: string } | undefined>
    ).main;
    return binding?.url ? binding : null;
  } catch {
    return null;
  }
}

export function dataDir(): string {
  return process.env.HIGHKEY_DATA_DIR ?? process.env.TAKO_DATA_DIR ?? "data";
}

export async function openDb(): Promise<Db | BunDb> {
  const binding = takoDatabase();
  if (binding) return openLibsqlDb(binding);
  const db = openBunDb(`${dataDir()}/state.sqlite`);
  await applyMigrations(db);
  return db;
}

/**
 * A Db that opens on first use, so the synchronous process context can hold it before the
 * database is open (and, without Tako, migrated). A failed open is retried on the next use.
 */
export function lazyDb(open: () => Promise<Db>): Db {
  let opened: Promise<Db> | null = null;
  const db = (): Promise<Db> => {
    opened ??= open().catch((error) => {
      opened = null;
      throw error;
    });
    return opened;
  };
  return {
    execute: async (sql, args) => (await db()).execute(sql, args),
    batch: async (statements, mode) => (await db()).batch(statements, mode),
    transaction: async (work) => (await db()).transaction(work),
    script: async (sql) => (await db()).script(sql),
    close: async () => {
      if (opened) await (await opened).close();
    },
  };
}
