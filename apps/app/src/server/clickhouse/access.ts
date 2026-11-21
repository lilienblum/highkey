// Each project reads its data as its own ClickHouse user, which can see only that project's
// views. The views hard-code the project and read the shared tables as highkey_definer, so a
// reader holds no grant on the shared tables at all. See "Isolation between projects" in the
// design for the barriers this stacks.
import { createHash, createHmac } from "node:crypto";
import { ClickHouse } from "./client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The project's UUID as 32 lowercase hex digits. Refuses anything that is not a UUID. */
export function id32(productId: string): string {
  const id = productId.toLowerCase();
  if (!UUID.test(id)) throw new Error(`Not a project id: ${productId}`);
  return id.replaceAll("-", "");
}

/** Prefixes of each project's ClickHouse database and reader user; the project's id32 follows. */
const DATABASE_PREFIX = "highkey_p_";
const READER_PREFIX = "highkey_r_";

export function projectDatabase(productId: string): string {
  return `${DATABASE_PREFIX}${id32(productId)}`;
}

export function readerUser(productId: string): string {
  return `${READER_PREFIX}${id32(productId)}`;
}

export function readerPassword(productId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`highkey-reader:${id32(productId)}`)
    .digest("hex");
}

export type { TimeBucket as Bucket } from "../../lib/time-buckets";
import type { TimeBucket as Bucket } from "../../lib/time-buckets";

export interface RunScope {
  from: Date;
  to: Date;
  source: string | null;
  bucket: Bucket;
}

/** The custom settings the project views read for a run's range, source and bucket. */
export function runSettings(scope: RunScope): Record<string, string> {
  return {
    SQL_highkey_from: String(scope.from.getTime()),
    SQL_highkey_to: String(scope.to.getTime()),
    SQL_highkey_source: scope.source ?? "",
    SQL_highkey_bucket: scope.bucket,
  };
}

const EVENT_COLUMNS =
  "source_id, event_id, name, source, sdk, event_time, received_at, actor_id, identity_kind, session_id, properties, backfill, profile_id, groups, geo.1 AS country,geo.2 AS region,device,browser,browser_version,os_family,os_version,referrer_name,referrer_type,bot, if(event_time + INTERVAL 30 DAY > now(), ai_prompt, '') AS ai_prompt";
const LOG_COLUMNS =
  "source_id, log_id, timestamp, received_at, level, message, service, environment, trace_id, span_id, request_id, attributes";

/** The start of a run's range, as the scoped views read it. */
export const RANGE_FROM =
  "fromUnixTimestamp64Milli(toInt64(getSettingOrDefault('SQL_highkey_from', 0)), 'UTC')";
const RANGE_TO =
  "fromUnixTimestamp64Milli(toInt64(getSettingOrDefault('SQL_highkey_to', 0)), 'UTC')";
const SOURCE = "toString(getSettingOrDefault('SQL_highkey_source', ''))";
/** The run's source, as the scoped views apply it: every source when none is set. */
export const SOURCE_SCOPE = `(${SOURCE} = '' OR source_id = toUUIDOrZero(${SOURCE}))`;

function scoped(time: string): string {
  return `${time} >= ${RANGE_FROM} AND ${time} < ${RANGE_TO} AND ${SOURCE_SCOPE}`;
}

/** The statements that create or refresh a project's database, views, reader user and grant. */
export function accessStatements(productId: string, secret: string): string[] {
  const database = projectDatabase(productId);
  const user = readerUser(productId);
  const project = `product_id = '${productId.toLowerCase()}'`;
  const ordinary = `record_type='event' AND (bot='' OR toString(getSettingOrDefault('SQL_highkey_include_bots','0'))='1')`;
  const view = (name: string, columns: string, table: string, where: string) =>
    `CREATE OR REPLACE VIEW ${database}.${name} DEFINER = highkey_definer SQL SECURITY DEFINER AS SELECT ${columns} FROM ${table} WHERE ${where}`;
  const identified = `IDENTIFIED WITH sha256_password BY '${readerPassword(productId, secret)}'`;
  const options = `DEFAULT DATABASE ${database} SETTINGS PROFILE 'highkey_reader'`;
  return [
    `CREATE DATABASE IF NOT EXISTS ${database}`,
    view(
      "events",
      EVENT_COLUMNS,
      "highkey.events",
      `${project} AND ${ordinary} AND ${scoped("event_time")}`,
    ),
    view("all_events", EVENT_COLUMNS, "highkey.events", `${project} AND ${ordinary}`),
    view(
      "cohort_members",
      "cohort_id,arrayJoin(members) AS profile_id",
      "highkey.cohort_snapshots FINAL",
      project,
    ),
    view(
      "event_facets",
      "source_id,day,name,property,samples",
      "highkey.event_facets",
      `${project} AND ${SOURCE_SCOPE} AND expires_at>now() AND day>=toDate(${RANGE_FROM}) AND day<=toDate(${RANGE_TO}-INTERVAL 1 MILLISECOND)`,
    ),
    // Profile attribution is a read-time join. Ordinary event aggregations stay on the narrow view.
    `CREATE OR REPLACE VIEW ${database}.profile_events DEFINER = highkey_definer SQL SECURITY DEFINER AS
      SELECT e.source_id AS source_id,e.event_id AS event_id,e.name AS name,e.source AS source,e.event_time AS event_time,e.received_at AS received_at,
        e.actor_id AS actor_id,e.identity_kind AS identity_kind,e.session_id AS session_id,e.properties AS properties,e.groups AS groups,e.backfill AS backfill,e.geo.1 AS country,e.geo.2 AS region,e.device AS device,e.browser AS browser,e.browser_version AS browser_version,e.os_family AS os_family,e.os_version AS os_version,e.referrer_name AS referrer_name,e.referrer_type AS referrer_type,e.bot AS bot,
        coalesce(e.profile_id,if(m.at <= e.event_time + INTERVAL 6 HOUR AND e.identity_kind='visitor',nullIf(m.profile,''),NULL)) AS profile_id
      FROM (SELECT *,geo,device,browser,browser_version,os_family,os_version,referrer_name,referrer_type,bot FROM highkey.events WHERE ${project} AND ${ordinary} AND ${scoped("event_time")}) e
      ASOF LEFT JOIN (SELECT source_id,actor_id,session_id,event_time AS at,argMin(profile_id,event_id) AS profile FROM highkey.session_profiles FINAL
        WHERE ${project} AND ${SOURCE_SCOPE} AND event_time >= ${RANGE_FROM} AND event_time < ${RANGE_TO} + INTERVAL 6 HOUR AND expires_at > now()
        GROUP BY source_id,actor_id,session_id,at) m
      ON e.source_id=m.source_id AND ifNull(e.actor_id,'')=m.actor_id AND ifNull(e.session_id,'')=m.session_id AND e.event_time<=m.at`,
    view(
      "profile_records",
      "source_id, event_id, event_time, received_at, profile_id, session_id, traits, increments",
      "highkey.events",
      `${project} AND record_type = 'identify'`,
    ),
    view(
      "group_records",
      "source_id, event_id, event_time, received_at, group_type, group_id, group_name, traits, increments",
      "highkey.events",
      `${project} AND record_type = 'group'`,
    ),
    view("logs", LOG_COLUMNS, "highkey.logs", `${project} AND ${scoped("timestamp")}`),
    view("all_logs", LOG_COLUMNS, "highkey.logs", project),
    view(
      "visit_fields",
      "source_id,actor_id,session_id,started_at,ended_at,entry_page,exit_page,duration_ms,events,page_views,bounced,first_referrer AS referrer,toString(net_cents) AS revenue_cents,context.1 AS country,context.2 AS region,context.3 AS device,context.4 AS browser,context.5 AS browser_version,context.6 AS os_family,context.7 AS os_version,context.8 AS referrer_type",
      "highkey.sessions",
      project,
    ),
    view(
      "sessions",
      "source_id, actor_id, session_id, started_at, ended_at, entry_page, exit_page, events, page_views, duration_ms, bounced, first_referrer AS referrer, first_campaign AS campaign, profile AS profile_id, toString(net_cents) AS revenue_cents,context.1 AS country,context.2 AS region,context.3 AS device,context.4 AS browser,context.5 AS browser_version,context.6 AS os_family,context.7 AS os_version,context.8 AS referrer_type",
      "highkey.sessions",
      `${project} AND ${scoped("started_at")}`,
    ),
    `CREATE USER IF NOT EXISTS ${user} ${identified} ${options}`,
    `ALTER USER ${user} ${identified} ${options}`,
    `GRANT SELECT ON ${database}.* TO ${user}`,
  ];
}

/** Creates or refreshes a project's database, views, reader user and grant. Idempotent. */
export async function ensureProjectAccess(
  admin: ClickHouse,
  productId: string,
  secret: string,
): Promise<void> {
  for (const sql of accessStatements(productId, secret)) await admin.command(sql);
}

/** Drops a project's reader user and its database with every view. Idempotent. */
export async function dropProjectAccess(admin: ClickHouse, productId: string): Promise<void> {
  await admin.command(`DROP USER IF EXISTS ${readerUser(productId)}`);
  await admin.command(`DROP DATABASE IF EXISTS ${projectDatabase(productId)}`);
}

/**
 * A fingerprint of what project access looks like in this release with this reader secret: the
 * statements for a placeholder project, hashed (the derived password never leaves the hash). A
 * new view definition, reader setting or secret changes it.
 */
export function accessVersion(secret: string): string {
  const statements = accessStatements("00000000-0000-0000-0000-000000000000", secret);
  return createHash("sha256").update(statements.join("\n")).digest("hex");
}

/**
 * The projects (as `id32`) whose database holds all views and whose reader exists with its
 * grant: everything `ensureProjectAccess` creates, read in one query.
 */
export async function provisionedProjects(admin: ClickHouse): Promise<Set<string>> {
  const result = await admin.query<{ id: string }>(
    `SELECT substring(database, ${DATABASE_PREFIX.length + 1}) AS id FROM system.tables WHERE startsWith(database, '${DATABASE_PREFIX}') AND name IN ('events', 'all_events', 'logs', 'all_logs', 'profile_records', 'profile_events','group_records','sessions','visit_fields','event_facets','cohort_members') GROUP BY database HAVING count() = 11
     INTERSECT
     SELECT substring(user_name, ${READER_PREFIX.length + 1}) AS id FROM system.grants WHERE startsWith(user_name, '${READER_PREFIX}') AND access_type = 'SELECT' AND database = concat('${DATABASE_PREFIX}', substring(user_name, ${READER_PREFIX.length + 1})) AND table IS NULL`,
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
