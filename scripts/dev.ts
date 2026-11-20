import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const stop = process.argv.includes("--stop");
if (!Bun.which("tako"))
  throw new Error("Install the Tako CLI before running bun dev: https://tako.sh");
if (!stop) {
  // Trust the local development CA explicitly; an existing daemon will not inherit
  // a new shell's trust variables. Both app configs point to this ignored link.
  const dataRoot =
    process.env.TAKO_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/tako")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "tako"));
  const certificate = join(dataRoot, "ca/ca.crt");
  const certificateLink = join(root, ".tako/dev-ca.pem");
  await mkdir(join(root, ".tako"), { recursive: true });
  const existingLink = await readlink(certificateLink).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EINVAL") return null;
    throw error;
  });
  if (existingLink !== certificate) {
    await rm(certificateLink, { force: true });
    await symlink(certificate, certificateLink);
  }
  // Both root configs share the encrypted secret store. List exposes names, never values.
  const listing = Bun.spawn(["tako", "-c", "tako.app.toml", "secrets", "list", "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  const metadata = (await new Response(listing.stdout).json()) as {
    secrets?: { name: string; environments: string[] }[];
  };
  if ((await listing.exited) !== 0)
    throw new Error("Could not inspect development secret configuration");
  if (
    !metadata.secrets?.some(
      (secret) =>
        secret.name === "HIGHKEY_CHANGE_TOKEN" && secret.environments.includes("development"),
    )
  ) {
    const token = crypto
      .getRandomValues(new Uint8Array(32))
      .reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
    const setup = Bun.spawn(
      [
        "tako",
        "-c",
        "tako.app.toml",
        "secrets",
        "set",
        "HIGHKEY_CHANGE_TOKEN",
        "--env",
        "development",
        "--ci",
      ],
      {
        cwd: root,
        stdin: new Blob([token]),
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await setup.exited) !== 0)
      throw new Error("Could not create the development change-notification secret");
  }
}
if (!stop) {
  // Events and logs live in ClickHouse: a persistent local server, migrated on every start.
  const clickhouse = Bun.spawn(["bun", "scripts/clickhouse.ts", "dev-up"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await clickhouse.exited) !== 0)
    throw new Error("Could not start ClickHouse; is Docker running?");
  // The ingest app serves /tracker.js from the SDK's browser bundle.
  const sdk = Bun.spawn(["bun", "run", "build:sdk"], {
    cwd: root,
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await sdk.exited) !== 0) throw new Error("Could not build the browser tracker");
}
for (const config of ["tako.ingest.toml", "tako.app.toml"]) {
  const command = stop
    ? ["tako", "-c", config, "dev", "stop"]
    : ["tako", "-c", config, "dev", "--background"];
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
if (!stop)
  console.log(
    "Highkey: https://highkey.test · Ingest: https://highkey-ingest.test\nStop both apps with bun run dev:stop; ClickHouse keeps running (bun scripts/clickhouse.ts dev-down stops it).",
  );
