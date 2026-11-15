import { beforeAll, describe, expect, test } from "bun:test";
import {
  ensureProjectAccess,
  projectDatabase,
  type RunScope,
  readerPassword,
  readerUser,
  Readers,
  runSettings,
} from "../src/server/clickhouse/access";
import { ClickHouse, ClickHouseError } from "../src/server/clickhouse/client";
import { migrate } from "../src/server/clickhouse/migrate";
import { testClickHouse } from "./clickhouse";

const secret = "access-test-secret";
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const sourceOne = crypto.randomUUID();
const sourceTwo = crypto.randomUUID();
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const day = 86_400_000;
let admin: ClickHouse;
let url: string;
let reader: ClickHouse;

const week: RunScope = {
  from: new Date(now - 7 * day),
  to: new Date(now + 1),
  source: null,
  bucket: "day",
};

function event(product: string, source: string, id: string, ageMs: number) {
  return {
    product_id: product,
    source_id: source,
    event_id: id,
    name: "page_view",
    source: "web",
    event_time: iso(now - ageMs),
    received_at: iso(now - ageMs),
    properties: { path: "/" },
    expires_at: iso(now + 365 * day).slice(0, 19),
  };
}

function log(product: string, source: string, id: string, ageMs: number) {
  return {
    product_id: product,
    source_id: source,
    log_id: id,
    timestamp: iso(now - ageMs),
    received_at: iso(now - ageMs),
    level: "info",
    message: "hello",
    service: "api",
    attributes: {},
    expires_at: iso(now + 365 * day).slice(0, 19),
  };
}

async function count(sql: string, scope: RunScope = week): Promise<number> {
  const result = await reader.query<{ n: string }>(sql, { settings: runSettings(scope) });
  return Number(result.data[0]?.n);
}

async function refused(sql: string, settings: Record<string, string | number> = {}) {
  try {
    const result = await reader.query(sql, { settings: { ...runSettings(week), ...settings } });
    return { refused: false, code: null as number | null, rows: result.data };
  } catch (error) {
    if (!(error instanceof ClickHouseError)) throw error;
    return { refused: true, code: error.code, rows: [] };
  }
}

beforeAll(async () => {
  const server = await testClickHouse();
  url = server.url;
  admin = new ClickHouse({ url, user: server.user, password: server.password });
  await migrate(admin, { ingestPassword: "piko-ingest-test" });
  await admin.insert("piko.events", [
    event(A, sourceOne, "a-recent-1", 2 * day),
    event(A, sourceTwo, "a-recent-2", 3_600_000),
    event(A, sourceOne, "a-old", 40 * day),
    event(B, B, "b-recent", day),
  ]);
  await admin.insert("piko.logs", [
    log(A, sourceOne, "a-log-1", 2 * day),
    log(A, sourceTwo, "a-log-2", 3_600_000),
    log(A, sourceOne, "a-log-old", 40 * day),
    log(B, B, "b-log", day),
  ]);
  await ensureProjectAccess(admin, A, secret);
  await ensureProjectAccess(admin, B, secret);
  reader = new Readers({ url, secret }).reader(A);
}, 300_000);

describe("project readers", () => {
  test("views return only the project's rows within the run scope", async () => {
    expect(await count("SELECT count() AS n FROM events")).toBe(2);
    expect(await count("SELECT count() AS n FROM all_events")).toBe(3);
    expect(await count("SELECT count() AS n FROM logs")).toBe(2);
    expect(await count("SELECT count() AS n FROM all_logs")).toBe(3);
    const one = { ...week, source: sourceOne };
    expect(await count("SELECT count() AS n FROM events", one)).toBe(1);
    expect(await count("SELECT count() AS n FROM logs", one)).toBe(1);
    // A query may widen its own range, but never past its project.
    expect(await count("SELECT count() AS n FROM events SETTINGS SQL_piko_from = '0'")).toBe(3);
    expect(
      await count(
        "SELECT count() AS n FROM events SETTINGS SQL_piko_source = '', SQL_piko_from = '0'",
      ),
    ).toBe(3);
  });

  test("the physical tables and other projects are unreachable", async () => {
    for (const table of [
      "piko.events",
      "piko.logs",
      "piko.ingest_keys",
      `${projectDatabase(B)}.events`,
      `${projectDatabase(B)}.all_logs`,
    ]) {
      const result = await refused(`SELECT count() FROM ${table}`);
      expect({ table, ...result }).toMatchObject({ table, refused: true, code: 497 });
    }
  });

  test("table functions, dictionaries and joinGet are refused", async () => {
    for (const sql of [
      `SELECT * FROM url('${url}/ping', 'TSV', 'x String')`,
      "SELECT * FROM file('users.xml', 'TSV', 'x String')",
      "SELECT count() FROM remote('127.0.0.1:9000', piko.events)",
      "SELECT * FROM s3('https://example.com/x.csv', 'CSV', 'x String')",
      "SELECT count() FROM merge('piko', '.*')",
      "SELECT count() FROM cluster('default', piko.events)",
      "SELECT dictGet('piko.nothing', 'x', toUInt64(1))",
      "SELECT joinGet('piko.events', 'name', 'x')",
    ]) {
      expect({ sql, ...(await refused(sql)) }).toMatchObject({ sql, refused: true });
    }
    // numbers() reads no data, so ClickHouse needs no grant for it; the profile's caps bound it.
    expect(await count("SELECT count() AS n FROM numbers(10)")).toBe(10);
  });

  test("system tables and information_schema are refused", async () => {
    for (const table of ["system.users", "system.query_log", "system.processes"]) {
      expect({ table, ...(await refused(`SELECT * FROM ${table}`)) }).toMatchObject({
        table,
        refused: true,
        code: 497,
      });
    }
    const schema = await refused("SELECT * FROM information_schema.tables");
    expect(schema.refused).toBe(true);
    // system.tables stays readable in ClickHouse, but lists only the reader's own views.
    const visible = await reader.query<{ database: string }>(
      "SELECT DISTINCT database FROM system.tables",
    );
    expect(visible.data.map((row) => row.database)).toEqual([projectDatabase(A)]);
  });

  test("writes, grants and role changes are refused", async () => {
    for (const sql of [
      "INSERT INTO events (event_id) VALUES ('x')",
      `INSERT INTO piko.events (product_id, event_id) VALUES ('${A}', 'x')`,
      "ALTER TABLE piko.events DELETE WHERE 1",
      "CREATE TABLE scratch (a Int8) ENGINE = Memory",
      "CREATE TEMPORARY TABLE scratch (a Int8)",
      "DROP TABLE events",
      `GRANT SELECT ON piko.* TO ${readerUser(A)}`,
      "SELECT 1 SETTINGS readonly = 0",
      "SELECT 1; SELECT 2",
    ]) {
      expect({ sql, ...(await refused(sql)) }).toMatchObject({ sql, refused: true });
    }
    // SET ROLE grants nothing: in the same session the physical tables stay out of reach.
    const session = `access-test-${crypto.randomUUID()}`;
    const send = (sql: string) =>
      fetch(`${url}/?session_id=${session}`, {
        method: "POST",
        headers: {
          "X-ClickHouse-User": readerUser(A),
          "X-ClickHouse-Key": readerPassword(A, secret),
        },
        body: sql,
      });
    await send("SET ROLE ALL");
    expect((await send("SELECT count() FROM piko.events")).status).not.toBe(200);
  });

  test("resource settings cannot be raised", async () => {
    for (const [name, value] of [
      ["max_memory_usage", 10_000_000_000],
      ["max_execution_time", 100],
      ["max_threads", 64],
      ["max_result_rows", 1_000_000],
      ["max_result_bytes", 100_000_000],
    ] as const) {
      const inline = await refused(`SELECT 1 SETTINGS ${name} = ${value}`);
      const sent = await refused("SELECT 1", { [name]: value });
      expect({ name, inline: inline.refused, sent: sent.refused }).toEqual({
        name,
        inline: true,
        sent: true,
      });
    }
  });

  test("B is unreachable by join, subquery, union, CTE or alias", async () => {
    for (const sql of [
      "SELECT count() FROM events AS e JOIN piko.events AS p ON e.event_id = p.event_id",
      "SELECT count() FROM (SELECT * FROM piko.events)",
      `SELECT count() FROM events UNION ALL SELECT count() FROM ${projectDatabase(B)}.events`,
      "WITH other AS (SELECT * FROM piko.events) SELECT count() FROM other",
      `SELECT count() FROM all_events WHERE product_id = '${B}'`,
      "SELECT count() FROM piko.events AS events",
    ]) {
      const result = await refused(sql);
      expect({ sql, refused: result.refused }).toEqual({ sql, refused: true });
    }
  });

  test("bucket() is callable and lands on the grid", async () => {
    const at = "toDateTime64('2026-11-18 13:45:30.123', 3, 'UTC')";
    const expected = {
      hour: "2026-11-18 13:00:00.000",
      day: "2026-11-18 00:00:00.000",
      week: "2026-11-16 00:00:00.000",
      month: "2026-11-01 00:00:00.000",
    } as const;
    for (const [bucket, value] of Object.entries(expected)) {
      const result = await reader.query<{ b: string }>(`SELECT bucket(${at}) AS b`, {
        settings: runSettings({ ...week, bucket: bucket as RunScope["bucket"] }),
      });
      expect({ bucket, value: result.data[0]?.b }).toEqual({ bucket, value });
    }
  });

  test("ensureProjectAccess is idempotent", async () => {
    const grants = async () =>
      (await admin.query<Record<string, string>>(`SHOW GRANTS FOR ${readerUser(A)}`)).data;
    const before = await grants();
    await ensureProjectAccess(admin, A, secret);
    expect(await grants()).toEqual(before);
    expect(await count("SELECT count() AS n FROM events")).toBe(2);
  });
});
