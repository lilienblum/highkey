import { describe, expect, test } from "bun:test";
import { assertIsolatedE2E, e2eApps, e2eConfig, e2eEnvironment } from "../scripts/e2e-config";

const run = "0123456789ab";
describe("browser test isolation", () => {
  test("rejects direct runs and preview URL overrides", () => {
    const { env } = e2eEnvironment("/highkey", run);
    expect(() => assertIsolatedE2E({})).toThrow("bun test:e2e");
    expect(() => assertIsolatedE2E({ ...env, HIGHKEY_API_URL: "https://highkey.test" })).toThrow();
    expect(() =>
      assertIsolatedE2E({ ...env, HIGHKEY_INGEST_URL: "https://highkey-ingest.test" }),
    ).toThrow();
    // The tests call the API where browsers do, on the dashboard.
    expect(env.HIGHKEY_API_URL).toBe(env.HIGHKEY_DASHBOARD_URL);
    expect(() =>
      assertIsolatedE2E({ ...env, HIGHKEY_DASHBOARD_URL: "https://highkey.test" }),
    ).toThrow();
    expect(() => assertIsolatedE2E(env)).not.toThrow();
    expect(() => e2eEnvironment("/highkey", "../app")).toThrow();
  });
  test("test_apps_sign_in_to_the_test_clickhouse_not_the_development_one", async () => {
    // The ingest app reads HIGHKEY_INGEST_CLICKHOUSE_PASSWORD before HIGHKEY_CLICKHOUSE_PASSWORD,
    // and the development config sets the former.
    const setup = e2eEnvironment("/highkey", run);
    const clickhouse = {
      url: "http://127.0.0.1:18124",
      password: "admin-e2e",
      ingestPassword: "ingest-e2e",
    };
    for (const app of e2eApps(setup, clickhouse)) {
      const config = Bun.TOML.parse(
        e2eConfig(
          await Bun.file(new URL(`../${app.template}`, import.meta.url)).text(),
          app.name,
          app.vars,
        ),
      ) as { vars: { development: Record<string, string> } };
      const vars = config.vars.development;
      expect(vars.HIGHKEY_CLICKHOUSE_URL).toBe(clickhouse.url);
      if (app.template === "tako.ingest.toml")
        expect(vars.HIGHKEY_INGEST_CLICKHOUSE_PASSWORD).toBe("ingest-e2e");
      else expect(vars.HIGHKEY_CLICKHOUSE_PASSWORD).toBe("admin-e2e");
    }
  });
  test("bun_trusts_the_local_ca_as_an_extra_certificate", async () => {
    // Bun rejects the dev certificate through SSL_CERT_FILE alone when stale CAs with the same
    // name sit in the system keychain; an extra CA certificate verifies it.
    const { env } = e2eEnvironment("/highkey", run);
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/highkey/.tako/dev-ca.pem");
    const dashboard = Bun.TOML.parse(
      await Bun.file(new URL("../tako.dashboard.toml", import.meta.url)).text(),
    ) as { vars: { development: Record<string, string> } };
    expect(dashboard.vars.development.NODE_EXTRA_CA_CERTS).toBe(".tako/dev-ca.pem");
  });
  test("derives isolated apps from the real configs and explicitly isolates storage and notifications", async () => {
    const setup = e2eEnvironment("/highkey", run);
    const ingest = Bun.TOML.parse(
      e2eConfig(
        await Bun.file(new URL("../tako.ingest.toml", import.meta.url)).text(),
        setup.ingestName,
        {
          HIGHKEY_CLICKHOUSE_URL: "http://127.0.0.1:18124",
          HIGHKEY_CHANGE_URL: `${setup.env.HIGHKEY_DASHBOARD_URL}/_highkey/changes`,
        },
      ),
    );
    expect(ingest).toMatchObject({
      name: "highkey-e2e-ingest",
      dev: ["cargo", "run", "-p", "highkey-ingest"],
      envs: { development: { route: "highkey-e2e-ingest.test" } },
      vars: {
        development: {
          HIGHKEY_CLICKHOUSE_URL: "http://127.0.0.1:18124",
          HIGHKEY_CHANGE_URL: "https://highkey-e2e.test/_highkey/changes",
          HIGHKEY_TRACKER_PATH: "sdk/typescript/dist/tracker.js",
          SSL_CERT_FILE: ".tako/dev-ca.pem",
        },
      },
    });
    const dashboard = Bun.TOML.parse(
      e2eConfig(
        await Bun.file(new URL("../tako.dashboard.toml", import.meta.url)).text(),
        setup.name,
        {
          HIGHKEY_DATA_DIR: setup.directory,
          HIGHKEY_INGEST_URL: setup.env.HIGHKEY_INGEST_URL,
        },
      ),
    );
    expect(dashboard).toMatchObject({
      name: "highkey-e2e",
      envs: { development: { route: "highkey-e2e.test" } },
      vars: {
        development: {
          HIGHKEY_DATA_DIR: "/highkey/.tako/e2e/0123456789ab",
          HIGHKEY_INGEST_URL: "https://highkey-e2e-ingest.test",
        },
      },
    });
    expect(
      (dashboard as { vars: { development: Record<string, string> } }).vars.development
        .HIGHKEY_API_URL,
    ).toBeUndefined();
    // The development config binds the Tako database `highkey`; a test run must never share it, so
    // the e2e dashboard keeps its state in its own data directory instead.
    expect(
      (dashboard as { envs: { development: Record<string, unknown> } }).envs.development.databases,
    ).toBeUndefined();
    expect(e2eEnvironment("/highkey", "abcdef012345").directory).not.toBe(setup.directory);
  });
});
