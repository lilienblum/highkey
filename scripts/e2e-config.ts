import { join } from "node:path";

export const E2E_ENV = "test-e2e";
export const E2E_CONFIGS = ["tako.ingest.toml", "tako.app.toml"];

export function e2eEnvironment(root: string, run: string) {
  if (!/^[a-f0-9]{12}$/.test(run)) throw new Error("Invalid E2E run ID");
  const name = `highkey-${E2E_ENV}`;
  const ingestName = `highkey-ingest-${E2E_ENV}`;
  return {
    name,
    ingestName,
    directory: join(root, ".tako", "data", "envs", E2E_ENV),
    env: {
      HIGHKEY_E2E_RUN: run,
      // The tests call the API where browsers do: on the dashboard.
      HIGHKEY_API_URL: `https://${name}.test`,
      HIGHKEY_INGEST_URL: `https://${ingestName}.test`,
      HIGHKEY_DASHBOARD_URL: `https://${name}.test`,
      HIGHKEY_REALTIME: "1",
      SSL_CERT_FILE: join(root, ".tako", "dev-ca.pem"),
      // Bun also needs it as an extra CA: through SSL_CERT_FILE alone, stale same-named CAs in
      // the system keychain fail verification.
      NODE_EXTRA_CA_CERTS: join(root, ".tako", "dev-ca.pem"),
    },
  };
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
