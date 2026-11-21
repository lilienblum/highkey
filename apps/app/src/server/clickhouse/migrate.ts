// Applies clickhouse/migrations/*.sql in name order and records each in highkey.schema_migrations.
//
// Migrations are expand-then-contract: a migration may add tables, columns with defaults,
// indexes and views at any time. Removing or renaming anything the ingest app writes or reads
// takes two releases, first an ingest app that no longer uses it, then the migration. Every
// statement must be safe to repeat (IF NOT EXISTS, OR REPLACE), since a failed run is retried.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouse } from "./client";

/** The ingest contract these migrations provide. Raise it with the migration that changes it. */
export const CONTRACT_VERSION = 7;

const defaultDir = new URL("../../../../../clickhouse/migrations/", import.meta.url).pathname;

/** Splits a migration file into statements: a statement ends at a line ending with `;`. */
export function statements(text: string): string[] {
  const found: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    current.push(line);
    if (line.trimEnd().endsWith(";")) {
      const statement = current.join("\n").trim().replace(/;$/, "").trim();
      if (statement) found.push(statement);
      current = [];
    }
  }
  const rest = current.join("\n").trim();
  if (rest) found.push(rest);
  return found;
}

function literal(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

async function ensureIngestUser(admin: ClickHouse, password: string): Promise<void> {
  const identified = `IDENTIFIED WITH sha256_password BY ${literal(password)}`;
  await admin.command(`CREATE USER IF NOT EXISTS highkey_ingest ${identified}`);
  await admin.command(`ALTER USER highkey_ingest ${identified} SETTINGS PROFILE 'highkey_ingest'`);
  await admin.command("GRANT INSERT, SELECT ON highkey.events TO highkey_ingest");
  await admin.command("GRANT INSERT, SELECT ON highkey.logs TO highkey_ingest");
  await admin.command("GRANT SELECT ON highkey.ingest_keys TO highkey_ingest");
  await admin.command("GRANT SELECT ON highkey.ingest_key_policies TO highkey_ingest");
  await admin.command("GRANT SELECT ON highkey.visitor_policies TO highkey_ingest");
  await admin.command("GRANT SELECT ON highkey.collection_exclusions TO highkey_ingest");
  await admin.command("GRANT SELECT ON highkey.ingest_contract TO highkey_ingest");
  await admin.command("GRANT dictGet ON highkey.geo_lookup TO highkey_ingest");
}

export async function migrate(
  admin: ClickHouse,
  options: { ingestPassword: string; migrationsDir?: string },
): Promise<{ applied: string[] }> {
  if (!options.ingestPassword) throw new Error("The ingest app's ClickHouse password is empty");
  const dir = options.migrationsDir ?? defaultDir;
  await admin.command("CREATE DATABASE IF NOT EXISTS highkey");
  await admin.command(
    "CREATE TABLE IF NOT EXISTS highkey.schema_migrations (name String, applied_at DateTime64(3, 'UTC')) ENGINE = MergeTree ORDER BY name",
  );
  const done = new Set(
    (await admin.query<{ name: string }>("SELECT name FROM highkey.schema_migrations")).data.map(
      (row) => row.name,
    ),
  );
  const applied: string[] = [];
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (done.has(file)) continue;
    for (const statement of statements(readFileSync(join(dir, file), "utf8")))
      await admin.command(statement);
    await admin.insert("highkey.schema_migrations", [
      { name: file, applied_at: new Date().toISOString().replace("T", " ").replace("Z", "") },
    ]);
    applied.push(file);
  }
  await ensureIngestUser(admin, options.ingestPassword);
  return { applied };
}
