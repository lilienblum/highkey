// The ClickHouse server for dashboard tests: `bun scripts/clickhouse.ts test-up`, started once
// per test process. HIGHKEY_TEST_CLICKHOUSE_URL points tests at another server instead.
import { ADMIN_USER, TEST_SERVER } from "../../../scripts/clickhouse";

export interface TestClickHouse {
  url: string;
  user: typeof ADMIN_USER;
  password: string;
}

let started: Promise<TestClickHouse> | undefined;

async function start(): Promise<TestClickHouse> {
  const password = process.env.HIGHKEY_TEST_CLICKHOUSE_PASSWORD ?? TEST_SERVER.password;
  const configured = process.env.HIGHKEY_TEST_CLICKHOUSE_URL;
  if (configured) return { url: configured, user: ADMIN_USER, password };
  const root = new URL("../../..", import.meta.url).pathname;
  const child = Bun.spawn(["bun", "scripts/clickhouse.ts", "test-up"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      `Could not start the test ClickHouse (needs Docker): ${stderr.trim() || stdout.trim()}`,
    );
  return { url: stdout.trim().split("\n").at(-1) ?? "", user: ADMIN_USER, password };
}

export function testClickHouse(): Promise<TestClickHouse> {
  started ??= start();
  return started;
}
