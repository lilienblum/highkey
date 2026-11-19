import { defineConfig } from "@playwright/test";
import { assertIsolatedE2E } from "./scripts/e2e-config";
import { E2E_STATE } from "./tests/auth";
assertIsolatedE2E(process.env);
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/setup.ts",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: process.env.HIGHKEY_DASHBOARD_URL,
    // Signed in as the workspace owner; tests about signing in start from an empty context.
    storageState: E2E_STATE,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
