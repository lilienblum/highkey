// The management database, behind one asynchronous interface. Under Tako it is the hosted
// database bound as `main` (libSQL over HTTP); without Tako (tests, `dev:standalone`) it is a
// bun:sqlite file. Both run the same SQL.

export type Value = string | number | bigint | null | Uint8Array;

export interface Result {
  rows: Record<string, Value>[];
  rowsAffected: number;
}

export interface Statement {
  sql: string;
  args?: Value[];
}

export interface Db {
  /** Runs one statement with positional `?` arguments. */
  execute(sql: string, args?: Value[]): Promise<Result>;
  /** Runs statements in order; a `write` batch is atomic. */
  batch(statements: Statement[], mode: "write" | "read"): Promise<Result[]>;
  /**
   * Runs `work` in one write transaction: it commits when `work` resolves and rolls back when it
   * throws. Keep it to database calls: Tako rolls back a transaction idle for 10 seconds.
   */
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  /** Runs several statements separated by semicolons (migrations only). */
  script(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** The management database cannot be reached or refused the work for now; retrying may succeed. */
export class StorageUnavailable extends Error {}

/** Every row of a query. */
export async function all<T>(db: Db, sql: string, args: Value[] = []): Promise<T[]> {
  return (await db.execute(sql, args)).rows as T[];
}

/** The first row of a query, or null. */
export async function one<T>(db: Db, sql: string, args: Value[] = []): Promise<T | null> {
  return ((await db.execute(sql, args)).rows[0] as T | undefined) ?? null;
}

/** Runs a write and returns how many rows it changed. */
export async function changes(db: Db, sql: string, args: Value[] = []): Promise<number> {
  return (await db.execute(sql, args)).rowsAffected;
}
