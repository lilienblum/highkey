// Development without Tako: a persistent local ClickHouse, the ingest app on 127.0.0.1:3001 and
// the dashboard (with the API) on 127.0.0.1:3000. Live updates fall back to polling.
import { DEV_SERVER, startClickHouse } from "./clickhouse";

const { url } = await startClickHouse(DEV_SERVER);
const build = Bun.spawn(["bun", "run", "build:sdk"], { stdout: "ignore", stderr: "inherit" });
if ((await build.exited) !== 0) throw new Error("Could not build the browser tracker");
const ingest = Bun.spawn(["cargo", "run", "-p", "piko-ingest"], {
  env: {
    ...process.env,
    PIKO_CLICKHOUSE_URL: url,
    PIKO_CLICKHOUSE_PASSWORD: DEV_SERVER.ingestPassword,
    PIKO_TRACKER_PATH: "sdk/typescript/dist/tracker.js",
  },
  stdout: "inherit",
  stderr: "inherit",
});
const dashboard = Bun.spawn(["bun", "run", "dev"], {
  cwd: "apps/dashboard",
  env: {
    ...process.env,
    PIKO_CLICKHOUSE_URL: url,
    PIKO_CLICKHOUSE_PASSWORD: DEV_SERVER.password,
    PIKO_INGEST_URL: "http://127.0.0.1:3001",
    PIKO_DATA_DIR: process.env.PIKO_DATA_DIR ?? `${process.cwd()}/data`,
  },
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    ingest.kill(signal);
    dashboard.kill(signal);
  });
await Promise.race([ingest.exited, dashboard.exited]);
ingest.kill();
dashboard.kill();
