import { join } from "node:path";

export function e2eEnvironment(root: string, run: string) {
  if (!/^[a-f0-9]{12}$/.test(run)) throw new Error("Invalid E2E run ID");
  const name = "highkey-e2e";
  return {
    name,
    ingestName: `${name}-ingest`,
    directory: join(root, ".tako", "e2e", run),
    env: {
      HIGHKEY_E2E_RUN: run,
      // The tests call the API where browsers do: on the dashboard.
      HIGHKEY_API_URL: `https://${name}.test`,
      HIGHKEY_INGEST_URL: `https://${name}-ingest.test`,
      HIGHKEY_DASHBOARD_URL: `https://${name}.test`,
      HIGHKEY_REALTIME: "1",
      SSL_CERT_FILE: join(root, ".tako", "dev-ca.pem"),
      // Bun also needs it as an extra CA: through SSL_CERT_FILE alone, stale same-named CAs in
      // the system keychain fail verification.
      NODE_EXTRA_CA_CERTS: join(root, ".tako", "dev-ca.pem"),
    },
  };
}

/**
 * The two disposable apps a browser-test run starts from the real configs, with the variables
 * that isolate them. Each app gets its ClickHouse credentials under the name it reads first,
 * so the development values in the templates never leak into a test run.
 */
export function e2eApps(
  setup: ReturnType<typeof e2eEnvironment>,
  clickhouse: { url: string; password: string; ingestPassword: string },
): { name: string; template: string; vars: Record<string, string> }[] {
  return [
    {
      name: setup.ingestName,
      template: "tako.ingest.toml",
      vars: {
        HIGHKEY_CLICKHOUSE_URL: clickhouse.url,
        HIGHKEY_INGEST_CLICKHOUSE_PASSWORD: clickhouse.ingestPassword,
        HIGHKEY_CHANGE_URL: `${setup.env.HIGHKEY_DASHBOARD_URL}/_highkey/changes`,
      },
    },
    {
      name: setup.name,
      template: "tako.app.toml",
      vars: {
        HIGHKEY_DATA_DIR: setup.directory,
        HIGHKEY_PUBLIC_URL: setup.env.HIGHKEY_DASHBOARD_URL,
        // Browser tests sign people up freely; the first account is made by tests/setup.ts.
        HIGHKEY_SIGNUP: "open",
        HIGHKEY_INGEST_URL: setup.env.HIGHKEY_INGEST_URL,
        HIGHKEY_CLICKHOUSE_URL: clickhouse.url,
        HIGHKEY_CLICKHOUSE_PASSWORD: clickhouse.password,
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `${setup.name}.tako,${setup.name}.test`,
      },
    },
  ];
}

export function assertIsolatedE2E(env: Record<string, string | undefined>) {
  const run = env.HIGHKEY_E2E_RUN;
  if (!run || !/^[a-f0-9]{12}$/.test(run))
    throw new Error("Run browser tests with bun test:e2e; direct runs can pollute preview data.");
  const expected = e2eEnvironment(".", run).env;
  if (
    env.HIGHKEY_API_URL !== expected.HIGHKEY_API_URL ||
    env.HIGHKEY_INGEST_URL !== expected.HIGHKEY_INGEST_URL ||
    env.HIGHKEY_DASHBOARD_URL !== expected.HIGHKEY_DASHBOARD_URL
  )
    throw new Error("Browser tests must use their disposable E2E apps, never the preview.");
}

export function e2eConfig(template: string, name: string, vars: Record<string, string>) {
  const config = Bun.TOML.parse(template) as {
    name: string;
    envs: { development: { route: string } };
    vars: { development: Record<string, string> };
  };
  config.name = name;
  config.envs.development.route = `${name}.test`;
  // A test app never binds the development Tako database: it keeps its state in its own data
  // directory, which teardown removes.
  delete (config.envs.development as Record<string, unknown>).databases;
  Object.assign(config.vars.development, vars);
  return Bun.TOML.stringify(config);
}
