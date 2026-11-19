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
