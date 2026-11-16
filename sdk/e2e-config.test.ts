import { describe, expect, test } from "bun:test";
import { assertIsolatedE2E, e2eConfig, e2eEnvironment } from "../scripts/e2e-config";

const run = "0123456789ab";
describe("browser test isolation", () => {
  test("rejects direct runs and preview URL overrides", () => {
    const { env } = e2eEnvironment("/piko", run);
    expect(() => assertIsolatedE2E({})).toThrow("bun test:e2e");
    expect(() => assertIsolatedE2E({ ...env, PIKO_API_URL: "https://piko.test" })).toThrow();
    expect(() =>
      assertIsolatedE2E({ ...env, PIKO_INGEST_URL: "https://piko-ingest.test" }),
    ).toThrow();
    // The tests call the API where browsers do, on the dashboard.
    expect(env.PIKO_API_URL).toBe(env.PIKO_DASHBOARD_URL);
    expect(() => assertIsolatedE2E({ ...env, PIKO_DASHBOARD_URL: "https://piko.test" })).toThrow();
    expect(() => assertIsolatedE2E(env)).not.toThrow();
    expect(() => e2eEnvironment("/piko", "../app")).toThrow();
  });
  test("derives isolated apps from the real configs and explicitly isolates storage and notifications", async () => {
    const setup = e2eEnvironment("/piko", run);
    const ingest = Bun.TOML.parse(
      e2eConfig(
        await Bun.file(new URL("../tako.ingest.toml", import.meta.url)).text(),
        setup.ingestName,
        {
          PIKO_CLICKHOUSE_URL: "http://127.0.0.1:18124",
          PIKO_CHANGE_URL: `${setup.env.PIKO_DASHBOARD_URL}/_piko/changes`,
        },
      ),
    );
    expect(ingest).toMatchObject({
      name: "piko-e2e-ingest",
      dev: ["cargo", "run", "-p", "piko-ingest"],
      envs: { development: { route: "piko-e2e-ingest.test" } },
      vars: {
        development: {
          PIKO_CLICKHOUSE_URL: "http://127.0.0.1:18124",
          PIKO_CHANGE_URL: "https://piko-e2e.test/_piko/changes",
          PIKO_TRACKER_PATH: "sdk/typescript/dist/tracker.js",
          SSL_CERT_FILE: ".tako/dev-ca.pem",
        },
      },
    });
    const dashboard = Bun.TOML.parse(
      e2eConfig(
        await Bun.file(new URL("../tako.dashboard.toml", import.meta.url)).text(),
        setup.name,
        {
          PIKO_DATA_DIR: setup.directory,
          PIKO_INGEST_URL: setup.env.PIKO_INGEST_URL,
        },
      ),
    );
    expect(dashboard).toMatchObject({
      name: "piko-e2e",
      envs: { development: { route: "piko-e2e.test" } },
      vars: {
        development: {
          PIKO_DATA_DIR: "/piko/.tako/e2e/0123456789ab",
          PIKO_INGEST_URL: "https://piko-e2e-ingest.test",
        },
      },
    });
    expect(
      (dashboard as { vars: { development: Record<string, string> } }).vars.development
        .PIKO_API_URL,
    ).toBeUndefined();
    expect(e2eEnvironment("/piko", "abcdef012345").directory).not.toBe(setup.directory);
  });
});
