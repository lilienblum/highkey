// Starts the ClickHouse server Piko uses in development and tests. Compose runs its own.
//
//   bun scripts/clickhouse.ts test-up    disposable server for `bun test` and `cargo test`
//   bun scripts/clickhouse.ts test-down
//   bun scripts/clickhouse.ts dev-up     persistent server for `bun dev`
//   bun scripts/clickhouse.ts dev-down
//
// `*-up` is idempotent: a running server is reused. It prints the server's URL.

/** Pinned image. compose.yaml must name the same tag. */
export const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:26.8.37.168";
/** The oldest server the apps accept. */
export const MIN_CLICKHOUSE = [25, 8] as const;
export const ADMIN_USER = "piko_admin";

const root = new URL("..", import.meta.url).pathname;
const config = `${root}deploy/clickhouse/config.d/piko.xml`;

export interface ServerOptions {
  name: string;
  port: number;
  tmpfs: boolean;
  volume?: string;
  password: string;
  memory?: string;
}

export const TEST_SERVER: ServerOptions = {
  name: "piko-test-clickhouse",
  port: 18123,
  tmpfs: true,
  password: "piko-test",
};

export const DEV_SERVER: ServerOptions = {
  name: "piko-dev-clickhouse",
  port: 8123,
  tmpfs: false,
  volume: "piko-dev-clickhouse",
  password: process.env.PIKO_CLICKHOUSE_PASSWORD ?? "piko-dev",
};

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function state(name: string): Promise<"running" | "stopped" | "missing"> {
  const result = await docker(["inspect", "--format", "{{.State.Running}}", name]);
  if (result.code !== 0) return "missing";
  return result.stdout === "true" ? "running" : "stopped";
}

export async function waitForClickHouse(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`ClickHouse at ${url} did not answer within ${timeoutMs} ms (${last})`);
}

export async function startClickHouse(options: ServerOptions): Promise<{ url: string }> {
  const url = `http://127.0.0.1:${options.port}`;
  const current = await state(options.name);
  if (current === "stopped") {
    const started = await docker(["start", options.name]);
    if (started.code !== 0) throw new Error(`docker start ${options.name}: ${started.stderr}`);
  } else if (current === "missing") {
    const args = [
      "run",
      "--detach",
      "--name",
      options.name,
      "--publish",
      `127.0.0.1:${options.port}:8123`,
      "--env",
      `CLICKHOUSE_USER=${ADMIN_USER}`,
      "--env",
      `CLICKHOUSE_PASSWORD=${options.password}`,
      "--env",
      "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
      // Mount the one file: the image's own config.d makes the server listen on all interfaces.
      "--volume",
      `${config}:/etc/clickhouse-server/config.d/piko.xml:ro`,
      "--ulimit",
      "nofile=262144:262144",
      ...(options.tmpfs
        ? ["--tmpfs", "/var/lib/clickhouse"]
        : ["--volume", `${options.volume}:/var/lib/clickhouse`]),
      ...(options.memory ? ["--memory", options.memory] : []),
      CLICKHOUSE_IMAGE,
    ];
    const run = await docker(args);
    if (run.code !== 0) throw new Error(`docker run ${options.name}: ${run.stderr}`);
  }
  await waitForClickHouse(url, 120_000);
  return { url };
}

export async function stopClickHouse(name: string): Promise<void> {
  if ((await state(name)) === "missing") return;
  const removed = await docker(["rm", "--force", name]);
  if (removed.code !== 0) throw new Error(`docker rm ${name}: ${removed.stderr}`);
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (command === "test-up") console.log((await startClickHouse(TEST_SERVER)).url);
    else if (command === "test-down") await stopClickHouse(TEST_SERVER.name);
    else if (command === "dev-up") console.log((await startClickHouse(DEV_SERVER)).url);
    else if (command === "dev-down") await stopClickHouse(DEV_SERVER.name);
    else {
      console.error("Usage: bun scripts/clickhouse.ts test-up|test-down|dev-up|dev-down");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
