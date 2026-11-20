// The bun:sqlite driver, for tests and running without Tako. One connection serves the process,
// so a lock serializes access: a statement from another request can never join a transaction
// that is open on the connection.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Db, type Result, type Statement, StorageUnavailable, type Value } from "./db";

export interface BunDb extends Db {
  /** The connection itself, which Better Auth shares so both see the same database. */
  readonly raw: Database;
}

class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
}

function storageError(error: unknown): unknown {
  const code = (error as { code?: string }).code ?? "";
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")
    ? new StorageUnavailable((error as Error).message)
    : error;
}

export function openBunDb(path: string): BunDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const lock = new Lock();

  const run = (sql: string, args: Value[] = []): Result => {
    try {
      const statement = raw.query(sql);
      if (statement.columnNames.length > 0)
        return { rows: statement.all(...args) as Record<string, Value>[], rowsAffected: 0 };
      const { changes } = statement.run(...args);
      return { rows: [], rowsAffected: changes };
    } catch (error) {
      throw storageError(error);
    }
  };
  const inTransaction = <T>(work: () => Promise<T>): Promise<T> =>
    (async () => {
      run("BEGIN IMMEDIATE");
      try {
        const value = await work();
        run("COMMIT");
        return value;
      } catch (error) {
        run("ROLLBACK");
        throw error;
      }
    })();

  // Inside a transaction the lock is already held: statements run directly, and a nested
  // transaction joins the open one.
  const tx: Db = {
    execute: async (sql, args) => run(sql, args),
    batch: async (statements) => statements.map((s) => run(s.sql, s.args)),
    transaction: (work) => work(tx),
    script: async (sql) => {
      raw.exec(sql);
    },
    close: async () => {},
  };

  return {
    raw,
    execute: (sql, args) => lock.run(async () => run(sql, args)),
    batch: (statements: Statement[], mode) =>
      lock.run(async () => {
        const all = async () => statements.map((s) => run(s.sql, s.args));
        return mode === "write" ? inTransaction(all) : all();
      }),
    transaction: (work) => lock.run(() => inTransaction(() => work(tx))),
    script: (sql) =>
      lock.run(async () => {
        raw.exec(sql);
      }),
    close: () =>
      lock.run(async () => {
        raw.close();
      }),
  };
}
