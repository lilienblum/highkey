// Applies `migrations/*.sql` the way Tako does when it serves the database: in numeric order, each
// file in one transaction with its row in `_tako_migrations`, refusing a file that changed after
// it was applied. Under Tako, Tako applies them; this runs them for tests and `dev:standalone`,
// and keeps the same history so such a file can later be imported into a Tako database.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./db";

/** The repository's `migrations/` directory, found from wherever this module was built. */
function findMigrations(): string {
  let dir = import.meta.dir;
  for (;;) {
    const candidate = join(dir, "migrations");
    if (existsSync(join(candidate, "0001_initial.sql"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(process.cwd(), "migrations");
    dir = parent;
  }
}

export const MIGRATIONS_DIR = findMigrations();

const FILE = /^(\d{1,18})_.*\.sql$/;
const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|END|ROLLBACK)\b/i;

function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Applies pending migrations from `dir` and returns their file names. */
export async function applyMigrations(
  db: Db,
  app = "highkey",
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = readdirSync(dir)
    .map((name) => ({ name, match: FILE.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
    .map((f) => ({ name: f.name, order: BigInt(f.match[1] as string) }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  for (let i = 1; i < files.length; i++)
    if (files[i]?.order === files[i - 1]?.order)
      throw new Error(`Two migrations share the number of ${files[i]?.name}`);

  await db.execute(
    "CREATE TABLE IF NOT EXISTS _tako_migrations(app TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(app, name))",
  );
  const { rows } = await db.execute("SELECT name, sha256 FROM _tako_migrations WHERE app = ?", [
    app,
  ]);
  const applied = new Map(rows.map((r) => [String(r.name), String(r.sha256)]));

  const done: string[] = [];
  for (const { name } of files) {
    const sql = readFileSync(join(dir, name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const previous = applied.get(name);
    if (previous !== undefined) {
      if (previous !== sha256)
        throw new Error(
          `Migration ${name} changed after it was applied; restore it and add a new file`,
        );
      continue;
    }
    const control = statements(sql).find((s) => TRANSACTION_CONTROL.test(s));
    if (control)
      throw new Error(
        `Migration ${name} contains ${control.split(/\s/)[0]?.toUpperCase()}; each file already runs in a transaction`,
      );
    // As under Tako: foreign keys are not enforced while a file runs, so it can rebuild a
    // referenced table, but they must hold before it commits.
    await db.execute("PRAGMA foreign_keys = OFF");
    try {
      await db.transaction(async (tx) => {
        await tx.script(sql);
        const broken = await tx.execute("PRAGMA foreign_key_check");
        if (broken.rows.length) throw new Error("foreign key check failed");
        await tx.execute(
          "INSERT INTO _tako_migrations(app, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
          [app, name, sha256, new Date().toISOString()],
        );
      });
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
    } finally {
      await db.execute("PRAGMA foreign_keys = ON");
    }
    done.push(name);
  }
  return done;
}
