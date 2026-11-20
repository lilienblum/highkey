import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { E2E_SERVER, startClickHouse, stopClickHouse } from "./clickhouse";
import { E2E_CONFIGS, E2E_ENV, e2eEnvironment } from "./e2e-config";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const setup = e2eEnvironment(root, run);
if (!Bun.which("tako"))
  throw new Error("Install Tako, then initialize local development with bun dev.");
if (!(await Bun.file(setup.env.SSL_CERT_FILE).exists()))
  throw new Error("Initialize local TLS once with bun dev.");

const configs = E2E_CONFIGS.map((config) => ({ config: `${root}${config}`, env: E2E_ENV }));

let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
async function command(args: string[], env = process.env, input?: string) {
  child = Bun.spawn(args, {
    cwd: root,
    env,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  child = undefined;
  return code;
}

async function runningApps(): Promise<{ name: string; config: string; env: string }[]> {
  const listing = Bun.spawn(["tako", "dev", "list", "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  const result = await new Response(listing.stdout).json();
  if ((await listing.exited) !== 0 || !result.ok || !Array.isArray(result.apps))
    throw new Error("Could not inspect running Tako apps");
  return result.apps;
}

async function restoreApps(apps: { config: string; env: string }[]) {
  const running = await runningApps();
  for (const app of apps) {
    if (
      !running.some((entry) => entry.config === app.config && entry.env === app.env) &&
      (await command([
        "tako",
        "-c",
        app.config,
        "dev",
        "--env",
        app.env,
        "--background",
        "--json",
      ])) !== 0
    )
      throw new Error(`Could not restore Tako app ${app.config} (${app.env})`);
  }
}

// Stable hostnames avoid issuing new local TLS certificates on every run.
await mkdir(`${root}.tako/e2e`, { recursive: true });
const lock = `${root}.tako/e2e/runner.lock`;
await mkdir(lock).catch(() => {
  throw new Error(
    `E2E runner is locked. If a previous run was force-killed, stop its test-e2e apps and remove ${lock}.`,
  );
});
let previous: Awaited<ReturnType<typeof runningApps>> = [];
let exitCode = 1;
let ownsResources = false;
const attempted: typeof configs = [];
try {
  previous = await runningApps();
  if (
    previous.some(
      (app) => app.env === E2E_ENV && configs.some((config) => app.config === config.config),
    )
  )
    throw new Error("A previous test-e2e app is still running; stop it before another test run.");
  ownsResources = true;
  await rm(setup.directory, { recursive: true, force: true });
  // Both root configs share this environment's encrypted secrets.
  for (const name of ["HIGHKEY_CHANGE_TOKEN", "BETTER_AUTH_SECRET"]) {
    if (
      (await command(
        ["tako", "-c", "tako.app.toml", "secrets", "set", name, "--env", E2E_ENV, "--ci"],
        process.env,
        `${crypto.randomUUID()}${crypto.randomUUID()}`,
      )) !== 0
    )
      throw new Error(`Could not initialize ${name} for ${E2E_ENV}`);
  }
  // A fresh, empty ClickHouse for this run, migrated before either app starts.
  await stopClickHouse(E2E_SERVER.name);
  await startClickHouse(E2E_SERVER);
  if ((await command(["bun", "run", "build:sdk"])) !== 0)
    throw new Error("Could not build the browser tracker");
  for (const config of configs) {
    if (interrupted) throw new Error("E2E startup interrupted");
    // Record before startup: the daemon may register an app even if readiness fails.
    attempted.push(config);
    if (
      (await command([
        "tako",
        "-c",
        config.config,
        "dev",
        "--env",
        config.env,
        "--background",
        "--json",
      ])) !== 0
    )
      throw new Error(`Could not start ${config.config} (${config.env})`);
  }
  // The first addition of a TLS name can restart Tako's daemon. Restore any
  // registrations it dropped, including the ingest app started just before the dashboard.
  await restoreApps([...previous, ...configs]);
  if (interrupted) throw new Error("E2E startup interrupted");
  console.log(`Disposable E2E workspace: ${setup.env.HIGHKEY_DASHBOARD_URL}`);
  exitCode = await command(
    ["bun", "node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
    { ...process.env, ...setup.env },
  );
} catch (error) {
  console.error(error);
} finally {
  for (const config of attempted.slice().reverse()) {
    // Do not remove open databases, even when the tests or app startup failed.
    await command(["tako", "-c", config.config, "dev", "stop", "--env", config.env, "--json"]);
  }
  await restoreApps(previous);
  const remaining = await runningApps();
  const stopped = attempted.every(
    (config) => !remaining.some((app) => app.config === config.config && app.env === config.env),
  );
  if (stopped) {
    if (ownsResources) {
      await stopClickHouse(E2E_SERVER.name);
      await rm(setup.directory, { recursive: true, force: true });
    }
    await rm(lock, { recursive: true });
    if (ownsResources) console.log("E2E apps stopped and their temporary databases removed.");
  } else {
    console.error(`E2E stop failed; isolated data retained at ${setup.directory}.`);
    exitCode = 1;
  }
}
process.exitCode = interrupted ? 130 : exitCode;
