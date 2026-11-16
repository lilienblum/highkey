import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLICKHOUSE_IMAGE } from "./clickhouse";

const root = new URL("..", import.meta.url).pathname;
const password = "piko-test";

async function cli(command: string): Promise<string> {
  const child = Bun.spawn(["bun", "scripts/clickhouse.ts", command], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`clickhouse.ts ${command} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function sql(url: string, query: string, user = "piko_admin", key = password) {
  const response = await fetch(`${url}/?default_format=JSON`, {
    method: "POST",
    headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": key },
    body: query,
  });
  const text = await response.text();
  return {
    status: response.status,
    code: response.headers.get("x-clickhouse-exception-code"),
    text,
    rows: response.ok && text ? (JSON.parse(text).data as Record<string, unknown>[]) : [],
  };
}

async function containerId(): Promise<string> {
  const child = Bun.spawn(["docker", "ps", "-q", "--filter", "name=^piko-test-clickhouse$"], {
    stdout: "pipe",
  });
  await child.exited;
  return (await new Response(child.stdout).text()).trim();
}

describe("the test ClickHouse", () => {
  test(
    "test-up starts a reachable server at the supported version",
    async () => {
      const { MIN_CLICKHOUSE } = await import("./clickhouse");
      const url = await cli("test-up");
      expect(url).toBe("http://127.0.0.1:18123");
      const { rows } = await sql(url, "SELECT version() AS version");
      const [major, minor] = String(rows[0]?.version).split(".").map(Number);
      expect(major * 100 + minor).toBeGreaterThanOrEqual(
        MIN_CLICKHOUSE[0] * 100 + MIN_CLICKHOUSE[1],
      );
    },
    { timeout: 300_000 },
  );

  test(
    "the Piko server config is applied",
    async () => {
      const url = await cli("test-up");
      // A user with no grants may not read system tables.
      await sql(url, "DROP USER IF EXISTS piko_probe_t1");
      await sql(url, "CREATE USER piko_probe_t1 IDENTIFIED BY 'probe-password'");
      // (system.tables stays readable but lists only what the user may see.)
      const probe = (query: string) => sql(url, query, "piko_probe_t1", "probe-password");
      const users = await probe("SELECT name FROM system.users");
      const queries = await probe("SELECT query FROM system.query_log");
      const info = await probe("SELECT table_name FROM information_schema.tables");
      const visible = await probe("SELECT name FROM system.tables");
      await sql(url, "DROP USER piko_probe_t1");
      expect(users.code).toBe("497");
      expect(queries.code).toBe("497");
      expect(info.code).toBe("497");
      expect(visible.rows).toEqual([]);
      // Noisy system logs stay off once the server has had time to flush them.
      const uptime = Number((await sql(url, "SELECT uptime() AS u")).rows[0]?.u ?? 0);
      if (uptime < 10) await Bun.sleep((10 - uptime) * 1000);
      const logs = await sql(
        url,
        "SELECT name FROM system.tables WHERE database = 'system' AND name IN ('trace_log', 'text_log', 'metric_log')",
      );
      expect(logs.rows).toEqual([]);
    },
    { timeout: 60_000 },
  );

  test(
    "test-up is idempotent",
    async () => {
      const first = await cli("test-up");
      const id = await containerId();
      const second = await cli("test-up");
      expect(second).toBe(first);
      expect(await containerId()).toBe(id);
    },
    { timeout: 60_000 },
  );
});

describe("deployment", () => {
  test("compose.yaml pins the same ClickHouse image as scripts/clickhouse.ts", () => {
    const compose = Bun.YAML.parse(readFileSync(`${root}compose.yaml`, "utf8")) as {
      services: Record<string, { image?: string }>;
    };
    expect(compose.services.clickhouse?.image).toBe(CLICKHOUSE_IMAGE);
  });
});
