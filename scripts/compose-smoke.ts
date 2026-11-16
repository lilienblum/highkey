// Builds and starts the Compose group with fresh passwords, sends one event through the
// dashboard's ingest forwarding, waits for Explore to count it, then removes everything.
//
//   bun scripts/compose-smoke.ts
const root = new URL("..", import.meta.url).pathname;
const project = "piko-smoke";
const port = process.env.PIKO_SMOKE_PORT ?? "13000";
const secret = () => crypto.randomUUID().replaceAll("-", "");
const env = {
  ...process.env,
  PIKO_PORT: port,
  PIKO_CLICKHOUSE_PASSWORD: secret(),
  PIKO_INGEST_CLICKHOUSE_PASSWORD: secret(),
  PIKO_CLICKHOUSE_MEMORY: "2g",
};
const base = `http://127.0.0.1:${port}`;

async function compose(args: string[]): Promise<void> {
  const child = Bun.spawn(["docker", "compose", "-p", project, ...args], {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`docker compose ${args.join(" ")} exited with ${code}`);
}

async function api<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-piko-admin": "1", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

let failed = false;
try {
  await compose(["up", "--build", "-d", "--wait"]);
  const product = await api<{ id: string }>("/api/products", {
    name: "Smoke",
    retention_days: 30,
  });
  const { key } = await api<{ key: string }>(`/api/products/${product.id}/keys`, {
    label: "Smoke",
  });
  const ack = await api<{ accepted: number }>(
    "/api/ingest",
    { event_id: crypto.randomUUID(), name: "smoke", source: "cli", properties: {} },
    { authorization: `Bearer ${key}`, "x-piko-admin": "" },
  );
  if (ack.accepted !== 1) throw new Error(`ingest accepted ${ack.accepted}`);
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const deadline = Date.now() + 30_000;
  let total: unknown = null;
  while (Date.now() < deadline) {
    const result = await api<{ summary: { total: number } }>(
      `/api/read/products/${product.id}/query`,
      { from, to },
    );
    total = result.summary.total;
    if (total === 1) break;
    await Bun.sleep(500);
  }
  if (total !== 1) throw new Error(`Explore counted ${total} events, expected 1`);
  console.log("Compose smoke: an event sent through the dashboard reached Explore.");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  await compose(["logs", "--tail", "50"]).catch(() => {});
} finally {
  await compose(["down", "-v"]).catch((error) => {
    failed = true;
    console.error(error);
  });
}
process.exitCode = failed ? 1 : 0;
