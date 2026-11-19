import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBunDb } from "../src/server/db/bun-db";
import type { Db } from "../src/server/db/db";
import { openLibsqlDb } from "../src/server/db/libsql-db";
import { applyMigrations, MIGRATIONS_DIR } from "../src/server/db/migrations";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "highkey-migrations-"));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

async function count(db: Db, table: string): Promise<number> {
  const { rows } = await db.execute(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

describe("the database interface", () => {
  test("execute_batch_and_transaction_round_trip", async () => {
    const db = openBunDb(":memory:");
    await db.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t(name) VALUES (?)", ["a"]);
    });
    expect((await db.execute("SELECT name FROM t")).rows).toEqual([{ name: "a" }]);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute("INSERT INTO t(name) VALUES (?)", ["b"]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await count(db, "t")).toBe(1);
    await expect(
      db.batch(
        [
          { sql: "INSERT INTO t(name) VALUES (?)", args: ["c"] },
          { sql: "INSERT INTO t(name) VALUES (?)", args: [null] },
        ],
        "write",
      ),
    ).rejects.toThrow();
    expect(await count(db, "t")).toBe(1);
    await db.close();
  });

  test("a_statement_outside_a_transaction_never_joins_it", async () => {
    const db = openBunDb(":memory:");
    await db.execute("CREATE TABLE t(name TEXT NOT NULL)");
    let begun = () => {};
    const open = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const inside = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t(name) VALUES ('inside')");
      begun();
      await Bun.sleep(20);
      throw new Error("roll back");
    });
    // Only once the transaction is open does another request write.
    await open;
    const outside = db.execute("INSERT INTO t(name) VALUES ('outside')");
    await expect(inside).rejects.toThrow("roll back");
    await outside;
    expect((await db.execute("SELECT name FROM t")).rows).toEqual([{ name: "outside" }]);
    await db.close();
  });
});

describe("migrations", () => {
  test("migrations_apply_in_order_once", async () => {
    const db = openBunDb(":memory:");
    const dir = migrationsDir({
      "0002_b.sql": "ALTER TABLE a ADD COLUMN extra TEXT;",
      "0001_a.sql": "CREATE TABLE a(id TEXT PRIMARY KEY);",
      "notes.txt": "ignored",
    });
    expect(await applyMigrations(db, "highkey", dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await applyMigrations(db, "highkey", dir)).toEqual([]);
    const { rows } = await db.execute(
      "SELECT app, name, length(sha256) AS hash FROM _tako_migrations ORDER BY name",
    );
    expect(rows).toEqual([
      { app: "highkey", name: "0001_a.sql", hash: 64 },
      { app: "highkey", name: "0002_b.sql", hash: 64 },
    ]);
    await db.close();
  });

  test("a_changed_applied_migration_is_refused", async () => {
    const db = openBunDb(":memory:");
    const dir = migrationsDir({ "0001_a.sql": "CREATE TABLE a(id TEXT);" });
    await applyMigrations(db, "highkey", dir);
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a(id TEXT, other TEXT);");
    await expect(applyMigrations(db, "highkey", dir)).rejects.toThrow("0001_a.sql");
    await db.close();
  });

  test("a_failing_migration_leaves_nothing", async () => {
    const db = openBunDb(":memory:");
    const dir = migrationsDir({
      "0001_a.sql": "CREATE TABLE a(id TEXT);",
      "0002_bad.sql": "CREATE TABLE b(id TEXT); INSERT INTO missing VALUES (1);",
    });
    await expect(applyMigrations(db, "highkey", dir)).rejects.toThrow("0002_bad.sql");
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.rows.map((r) => r.name)).not.toContain("b");
    const applied = await db.execute("SELECT name FROM _tako_migrations");
    expect(applied.rows).toEqual([{ name: "0001_a.sql" }]);
    await db.close();
  });

  test("a_file_with_begin_or_commit_is_refused", async () => {
    const db = openBunDb(":memory:");
    const dir = migrationsDir({ "0001_a.sql": "BEGIN;\nCREATE TABLE a(id TEXT);\nCOMMIT;" });
    await expect(applyMigrations(db, "highkey", dir)).rejects.toThrow("BEGIN");
    await db.close();
  });

  test("the_initial_migration_builds_todays_schema", async () => {
    const db = openBunDb(":memory:");
    await applyMigrations(db, "highkey", MIGRATIONS_DIR);
    const { rows } = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(
      [
        "dashboard_revisions",
        "dashboards",
        "ingestion_keys",
        "log_keys",
        "log_settings",
        "products",
        "retention_changes",
        "settings",
        "sources",
        "views",
      ].sort(),
    );
    await db.close();
  });
});

describe.each([
  ["bun:sqlite", () => openBunDb(":memory:")],
  [
    "libSQL",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "highkey-libsql-"));
      dirs.push(dir);
      return openLibsqlDb({ url: `file:${join(dir, "state.sqlite")}` });
    },
  ],
] as const)("both drivers (%s)", (_name, open) => {
  test("both_drivers_behave_the_same", async () => {
    const db = open();
    await db.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon BLOB)");
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t(name, icon) VALUES (?, ?)", ["a", new Uint8Array([1, 2, 3])]);
    });
    const { rows } = await db.execute("SELECT id, name, icon FROM t");
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.name).toBe("a");
    expect(rows[0]?.icon).toBeInstanceOf(Uint8Array);
    expect(Array.from((rows[0]?.icon ?? new Uint8Array()) as Uint8Array)).toEqual([1, 2, 3]);
    const updated = await db.execute("UPDATE t SET name = ? WHERE id = ?", ["b", 1]);
    expect(updated.rowsAffected).toBe(1);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute("INSERT INTO t(name) VALUES ('c')");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const counted = await db.execute("SELECT count(*) AS n FROM t");
    expect(Number(counted.rows[0]?.n)).toBe(1);
    await db.script(
      "CREATE TABLE u(id INTEGER); INSERT INTO u VALUES (1); INSERT INTO u VALUES (2);",
    );
    const u = await db.batch([{ sql: "SELECT count(*) AS n FROM u" }], "read");
    expect(Number(u[0]?.rows[0]?.n)).toBe(2);
    await db.close();
  });

  test("the_initial_migration_applies_on_both", async () => {
    const db = open();
    expect(await applyMigrations(db, "highkey", MIGRATIONS_DIR)).toContain("0001_initial.sql");
    await db.close();
  });
});

describe("adopting a state file from before migrations", () => {
  test("a_store_file_from_before_migrations_is_adopted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "highkey-legacy-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    // What the dashboard wrote before migrations/: today's tables and user_version 2.
    const legacy = openBunDb(path);
    await legacy.script(readFileSync(join(MIGRATIONS_DIR, "0001_initial.sql"), "utf8"));
    await legacy.execute("PRAGMA user_version = 2");
    await legacy.execute(
      "INSERT INTO products(id, name, retention_days, created_at, slug) VALUES ('p', 'Kept', 30, 'now', 'kept')",
    );
    await legacy.close();
    const db = openBunDb(path);
    expect(await applyMigrations(db, "highkey", MIGRATIONS_DIR)).not.toContain("0001_initial.sql");
    const { rows } = await db.execute("SELECT name FROM products");
    expect(rows).toEqual([{ name: "Kept" }]);
    const adopted = await db.execute("SELECT name FROM _tako_migrations");
    expect(adopted.rows.map((r) => r.name)).toContain("0001_initial.sql");
    await db.close();
  });
});
