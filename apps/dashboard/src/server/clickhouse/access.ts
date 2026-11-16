// Each project reads its data as its own ClickHouse user, which can see only that project's
// views. The views hard-code the project and read the shared tables as piko_definer, so a
// reader holds no grant on the shared tables at all. See "Isolation between projects" in the
// design for the barriers this stacks.
import { createHmac } from "node:crypto";
import { ClickHouse } from "./client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The project's UUID as 32 lowercase hex digits. Refuses anything that is not a UUID. */
export function id32(productId: string): string {
  const id = productId.toLowerCase();
  if (!UUID.test(id)) throw new Error(`Not a project id: ${productId}`);
  return id.replaceAll("-", "");
}

export function projectDatabase(productId: string): string {
  return `piko_p_${id32(productId)}`;
}

export function readerUser(productId: string): string {
  return `piko_r_${id32(productId)}`;
}

export function readerPassword(productId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`piko-reader:${id32(productId)}`)
    .digest("hex");
}

export type Bucket = "hour" | "day" | "week" | "month";

export interface RunScope {
  from: Date;
  to: Date;
  source: string | null;
  bucket: Bucket;
}

/** The custom settings the project views read for a run's range, source and bucket. */
export function runSettings(scope: RunScope): Record<string, string> {
  return {
    SQL_piko_from: String(scope.from.getTime()),
    SQL_piko_to: String(scope.to.getTime()),
    SQL_piko_source: scope.source ?? "",
    SQL_piko_bucket: scope.bucket,
  };
}

const EVENT_COLUMNS =
  "source_id, event_id, name, source, event_time, received_at, actor_id, identity_kind, session_id, properties";
const LOG_COLUMNS =
  "source_id, log_id, timestamp, received_at, level, message, service, environment, trace_id, span_id, request_id, attributes";

/** The start of a run's range, as the scoped views read it. */
export const RANGE_FROM =
  "fromUnixTimestamp64Milli(toInt64(getSettingOrDefault('SQL_piko_from', 0)), 'UTC')";
const RANGE_TO = "fromUnixTimestamp64Milli(toInt64(getSettingOrDefault('SQL_piko_to', 0)), 'UTC')";
const SOURCE = "toString(getSettingOrDefault('SQL_piko_source', ''))";
/** The run's source, as the scoped views apply it: every source when none is set. */
export const SOURCE_SCOPE = `(${SOURCE} = '' OR source_id = toUUIDOrZero(${SOURCE}))`;

function scoped(time: string): string {
  return `${time} >= ${RANGE_FROM} AND ${time} < ${RANGE_TO} AND ${SOURCE_SCOPE}`;
}

/** Creates or refreshes a project's database, views, reader user and grant. Idempotent. */
export async function ensureProjectAccess(
  admin: ClickHouse,
  productId: string,
  secret: string,
): Promise<void> {
  const database = projectDatabase(productId);
  const user = readerUser(productId);
  const project = `product_id = '${productId.toLowerCase()}'`;
  const view = (name: string, columns: string, table: string, where: string) =>
    admin.command(
      `CREATE OR REPLACE VIEW ${database}.${name} DEFINER = piko_definer SQL SECURITY DEFINER AS SELECT ${columns} FROM ${table} WHERE ${where}`,
    );
  await admin.command(`CREATE DATABASE IF NOT EXISTS ${database}`);
  await view("events", EVENT_COLUMNS, "piko.events", `${project} AND ${scoped("event_time")}`);
  await view("all_events", EVENT_COLUMNS, "piko.events", project);
  await view("logs", LOG_COLUMNS, "piko.logs", `${project} AND ${scoped("timestamp")}`);
  await view("all_logs", LOG_COLUMNS, "piko.logs", project);
  const identified = `IDENTIFIED WITH sha256_password BY '${readerPassword(productId, secret)}'`;
  const options = `DEFAULT DATABASE ${database} SETTINGS PROFILE 'piko_reader'`;
  await admin.command(`CREATE USER IF NOT EXISTS ${user} ${identified} ${options}`);
  await admin.command(`ALTER USER ${user} ${identified} ${options}`);
  await admin.command(`GRANT SELECT ON ${database}.* TO ${user}`);
}

/**
 * The projects (as `id32`) whose database holds all four views and whose reader exists with its
 * grant: everything `ensureProjectAccess` creates, read in one query.
 */
export async function provisionedProjects(admin: ClickHouse): Promise<Set<string>> {
  const result = await admin.query<{ id: string }>(
    `SELECT substring(database, 8) AS id FROM system.tables WHERE startsWith(database, 'piko_p_') AND name IN ('events', 'all_events', 'logs', 'all_logs') GROUP BY database HAVING count() = 4
     INTERSECT
     SELECT substring(user_name, 8) AS id FROM system.grants WHERE startsWith(user_name, 'piko_r_') AND access_type = 'SELECT' AND database = concat('piko_p_', substring(user_name, 8)) AND table IS NULL`,
  );
  return new Set(result.data.map((row) => row.id));
}

/** One ClickHouse client per project, signed in as that project's reader. */
export class Readers {
  private readonly clients = new Map<string, ClickHouse>();

  constructor(private readonly options: { url: string; secret: string }) {}

  reader(productId: string): ClickHouse {
    const key = id32(productId);
    let client = this.clients.get(key);
    if (!client) {
      client = new ClickHouse({
        url: this.options.url,
        user: readerUser(productId),
        password: readerPassword(productId, this.options.secret),
      });
      this.clients.set(key, client);
    }
    return client;
  }
}
