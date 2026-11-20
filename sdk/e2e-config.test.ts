import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { E2E_SERVER } from "../scripts/clickhouse";
import { assertIsolatedE2E, E2E_CONFIGS, E2E_ENV, e2eEnvironment } from "../scripts/e2e-config";
import { E2E_DATABASE } from "../tests/auth";

const run = "0123456789ab";
const setup = e2eEnvironment("/highkey", run);
async function config(name: string) {
  return Bun.TOML.parse(await Bun.file(new URL(`../${name}`, import.meta.url)).text()) as {
    name: string;
    envs: Record<string, { route?: string; databases?: Record<string, string> }>;
    vars: Record<string, Record<string, string>>;
  };
}

describe("browser test isolation", () => {
  test("rejects direct runs and preview URL overrides", () => {
    const { env } = setup;
    expect(() => assertIsolatedE2E({})).toThrow("bun test:e2e");
    for (const key of ["HIGHKEY_API_URL", "HIGHKEY_INGEST_URL", "HIGHKEY_DASHBOARD_URL"]) {
      expect(() => assertIsolatedE2E({ ...env, [key]: "https://highkey.test" })).toThrow();
    }
    expect(env.HIGHKEY_API_URL).toBe(env.HIGHKEY_DASHBOARD_URL);
    expect(() => assertIsolatedE2E(env)).not.toThrow();
    expect(() => e2eEnvironment("/highkey", "../app")).toThrow();
  });

  test("main configs isolate ClickHouse credentials, routes, and notifications", async () => {
    for (const path of E2E_CONFIGS) {
      const app = await config(path);
      const vars = app.vars[E2E_ENV];
      expect(vars.HIGHKEY_CLICKHOUSE_URL).toBe(`http://127.0.0.1:${E2E_SERVER.port}`);
      expect(vars.HIGHKEY_CLICKHOUSE_URL).not.toBe(app.vars.development.HIGHKEY_CLICKHOUSE_URL);
      expect(app.envs[E2E_ENV].route).toBe(`${app.name}-${E2E_ENV}.test`);
      expect(vars.SSL_CERT_FILE).toBe(".tako/dev-ca.pem");
      // A data-dir override would bypass Tako's environment isolation.
      expect(vars.HIGHKEY_DATA_DIR).toBeUndefined();
      if (path === "tako.ingest.toml") {
        expect(vars.HIGHKEY_INGEST_CLICKHOUSE_PASSWORD).toBe(E2E_SERVER.ingestPassword);
        expect(vars.HIGHKEY_CHANGE_URL).toBe(`${setup.env.HIGHKEY_DASHBOARD_URL}/_highkey/changes`);
        expect(vars.HIGHKEY_TRACKER_PATH).toBe("sdk/typescript/dist/tracker.js");
      } else {
        expect(vars.HIGHKEY_CLICKHOUSE_PASSWORD).toBe(E2E_SERVER.password);
        expect(vars.HIGHKEY_PUBLIC_URL).toBe(setup.env.HIGHKEY_DASHBOARD_URL);
        expect(vars.HIGHKEY_INGEST_URL).toBe(setup.env.HIGHKEY_INGEST_URL);
        expect(vars.HIGHKEY_SIGNUP).toBe("open");
        expect(vars.NODE_EXTRA_CA_CERTS).toBe(".tako/dev-ca.pem");
        expect(vars.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toContain(`${setup.name}.test`);
      }
    }
    expect(setup.env.NODE_EXTRA_CA_CERTS).toBe("/highkey/.tako/dev-ca.pem");
  });

  test("tests exercise a separate Tako database with the real migrations", async () => {
    const app = await config("tako.app.toml");
    expect(app.envs[E2E_ENV].databases).toEqual({ main: "highkey-test-e2e" });
    expect(app.envs.development.databases).toEqual({ main: "highkey" });
    expect(setup.directory).toBe("/highkey/.tako/data/envs/test-e2e");
    expect(E2E_DATABASE).toBe(
      join(
        e2eEnvironment(process.cwd(), run).directory,
        "databases",
        `${app.envs[E2E_ENV].databases?.main}.sqlite`,
      ),
    );
  });
});
