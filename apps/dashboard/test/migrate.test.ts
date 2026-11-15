import { beforeAll, describe, expect, test } from "bun:test";
import { ClickHouse, ClickHouseError } from "../src/server/clickhouse/client";
import { CONTRACT_VERSION, migrate } from "../src/server/clickhouse/migrate";
import { testClickHouse } from "./clickhouse";

const ingestPassword = "piko-ingest-test";
let admin: ClickHouse;
let url: string;

beforeAll(async () => {
  const server = await testClickHouse();
  url = server.url;
  admin = new ClickHouse({ url, user: server.user, password: server.password });
  await migrate(admin, { ingestPassword });
}, 300_000);

async function columns(table: string) {
  const result = await admin.query<{ name: string; type: string }>(
    "SELECT name, type FROM system.columns WHERE database = 'piko' AND table = {table:String} ORDER BY position",
    { params: { table } },
  );
  return result.data.map((row) => `${row.name} ${row.type}`);
}

async function code(run: () => Promise<unknown>): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof ClickHouseError)) throw error;
    return error.code;
  }
}

describe("ClickHouse migrations", () => {
  test("a second run applies nothing", async () => {
    expect((await migrate(admin, { ingestPassword })).applied).toEqual([]);
  });

  test("events and logs have the contract columns", async () => {
    expect(await columns("events")).toEqual([
      "product_id UUID",
      "source_id UUID",
      "event_id String",
      "name LowCardinality(String)",
      "source LowCardinality(String)",
      "event_time DateTime64(3, 'UTC')",
      "received_at DateTime64(3, 'UTC')",
      "actor_id Nullable(String)",
      "identity_kind LowCardinality(Nullable(String))",
      "session_id Nullable(String)",
      "properties JSON",
      "expires_at DateTime('UTC')",
      "dedup_version UInt64",
    ]);
    expect(await columns("logs")).toEqual([
      "product_id UUID",
      "source_id UUID",
      "log_id String",
      "timestamp DateTime64(3, 'UTC')",
      "received_at DateTime64(3, 'UTC')",
      "level Enum8('trace' = 1, 'debug' = 2, 'info' = 3, 'warn' = 4, 'error' = 5, 'fatal' = 6)",
      "message String",
      "service LowCardinality(String)",
      "environment LowCardinality(Nullable(String))",
      "trace_id Nullable(String)",
      "span_id Nullable(String)",
      "request_id Nullable(String)",
      "attributes JSON",
      "expires_at DateTime('UTC')",
      "dedup_version UInt64",
    ]);
  });

  test("the contract version is recorded", async () => {
    const result = await admin.query<{ version: number }>(
      "SELECT max(version) AS version FROM piko.ingest_contract",
    );
    expect(result.data[0]?.version).toBe(CONTRACT_VERSION);
  });

  test("piko_ingest can write and read events but nothing else", async () => {
    const ingest = new ClickHouse({ url, user: "piko_ingest", password: ingestPassword });
    const product = crypto.randomUUID();
    await ingest.insert("piko.events", [
      {
        product_id: product,
        source_id: product,
        event_id: "e-1",
        name: "signup",
        source: "web",
        event_time: "2026-11-15 10:00:00.000",
        received_at: "2026-11-15 10:00:01.000",
        properties: { plan: "pro" },
        expires_at: "2027-11-15 10:00:00",
      },
    ]);
    const read = await ingest.query<{ count: string }>(
      "SELECT count() AS count FROM piko.events WHERE product_id = {product:UUID}",
      { params: { product } },
    );
    expect(Number(read.data[0]?.count)).toBe(1);
    await ingest.query("SELECT hash FROM piko.ingest_keys LIMIT 1");
    expect(await code(() => ingest.command("DROP TABLE piko.events"))).toBe(497);
    expect(
      await code(() =>
        ingest.insert("piko.ingest_keys", [{ hash: "x", product_id: product, source_id: product }]),
      ),
    ).toBe(497);
    expect(await code(() => ingest.query("SELECT name FROM system.users"))).toBe(497);
  });

  test("the first copy survives a merge", async () => {
    const product = crypto.randomUUID();
    const row = {
      product_id: product,
      source_id: product,
      event_id: "same-id",
      name: "signup",
      event_time: "2026-11-15 10:00:00.000",
      properties: {},
      expires_at: "2027-11-15 10:00:00",
    };
    await admin.insert("piko.events", [
      { ...row, source: "first", received_at: "2026-11-15 10:00:01.000" },
    ]);
    await admin.insert("piko.events", [
      { ...row, source: "second", received_at: "2026-11-15 10:05:00.000" },
    ]);
    await admin.command("OPTIMIZE TABLE piko.events FINAL");
    const result = await admin.query<{ source: string; received_at: string }>(
      "SELECT source, received_at FROM piko.events WHERE product_id = {product:UUID}",
      { params: { product } },
    );
    expect(result.data).toEqual([{ source: "first", received_at: "2026-11-15 10:00:01.000" }]);
  });
});
