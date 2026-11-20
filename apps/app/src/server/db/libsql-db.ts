// The libSQL driver: Tako's hosted database (Hrana over HTTP) in development and production, and
// a local `file:` database in tests. Integers stay JavaScript numbers; libSQL refuses one beyond
// 2^53 rather than rounding it, and Highkey stores none that large.
import {
  type Client,
  createClient,
  type InStatement,
  type ResultSet,
  type Transaction,
} from "@libsql/client";
import { type Db, type Result, type Statement, StorageUnavailable, type Value } from "./db";

const UNAVAILABLE = /^(SQLITE_BUSY|SQLITE_LOCKED|SERVER_ERROR|STREAM_EXPIRED|HRANA_)/;
const NETWORK = /fetch failed|ECONNREFUSED|ECONNRESET|socket|timed out|\b50[234]\b/i;

function storageError(error: unknown): unknown {
  const code = String((error as { code?: string }).code ?? "");
  const message = (error as Error)?.message ?? "";
  return UNAVAILABLE.test(code) || NETWORK.test(message) ? new StorageUnavailable(message) : error;
}

function value(raw: unknown): Value {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw as Value;
}

function result(set: ResultSet): Result {
  return {
    rows: set.rows.map((row) =>
      Object.fromEntries(set.columns.map((column, i) => [column, value(row[i])])),
    ),
    rowsAffected: set.rowsAffected,
  };
}

const statement = (sql: string, args: Value[] = []): InStatement => ({
  sql,
  args: args as InStatement extends { args?: infer A } ? A : never,
});

function wrap<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error) => {
    throw storageError(error);
  });
}

function transactionDb(tx: Transaction): Db {
  const db: Db = {
    execute: (sql, args) => wrap(async () => result(await tx.execute(statement(sql, args)))),
    batch: (statements) =>
      wrap(async () =>
        (await tx.batch(statements.map((s) => statement(s.sql, s.args)))).map(result),
      ),
    transaction: (work) => work(db),
    script: (sql) => wrap(() => tx.executeMultiple(sql)),
    close: async () => {},
  };
  return db;
}

export function openLibsqlDb(config: { url: string; authToken?: string }): Db {
  const client: Client = createClient({ url: config.url, authToken: config.authToken });
  return {
    execute: (sql, args) => wrap(async () => result(await client.execute(statement(sql, args)))),
    batch: (statements: Statement[], mode) =>
      wrap(async () =>
        (
          await client.batch(
            statements.map((s) => statement(s.sql, s.args)),
            mode,
          )
        ).map(result),
      ),
    transaction: async (work) => {
      const tx = await wrap(() => client.transaction("write"));
      try {
        const done = await work(transactionDb(tx));
        await wrap(() => tx.commit());
        return done;
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw storageError(error);
      } finally {
        tx.close();
      }
    },
    script: (sql) => wrap(() => client.executeMultiple(sql)),
    close: async () => client.close(),
  };
}
