// Account screens in the browser: signing up, signing in with a two-factor code, joining by
// invitation, and connecting an agent with read-only access.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { expect, request, test } from "@playwright/test";
import { totpCode } from "../apps/dashboard/test/totp";
import { E2E_STATE } from "./auth";

const base = process.env.HIGHKEY_DASHBOARD_URL as string;
const PASSWORD = "a long enough password";

// These tests start signed out, except where they borrow the owner's session.
test.use({ storageState: { cookies: [], origins: [] } });

async function signedUp(email: string) {
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const response = await api.post("/api/auth/sign-up/email", {
    data: { name: email.split("@")[0], email, password: PASSWORD },
  });
  expect(response.ok()).toBe(true);
  return api;
}

async function activeOrganization(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session");
    const body = (await response.json()) as { session?: { activeOrganizationId?: string } };
    return body?.session?.activeOrganizationId ?? null;
  });
}

test("sign up and land in your own organization", async ({ page }) => {
  const email = `newcomer-${Date.now()}@example.com`;
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill("Newcomer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(`${base}/`);
  await expect(page.locator(".workspace-sidebar")).toBeVisible();
  expect(await activeOrganization(page)).toBeTruthy();
});

test("a wrong password says so and keeps the form", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@highkey-e2e.test");
  await page.getByLabel("Password").fill("not the password at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("don’t match");
  await expect(page.getByLabel("Email")).toHaveValue("owner@highkey-e2e.test");
});

test("sign in with a two-factor code", async ({ page }) => {
  const email = `careful-${Date.now()}@example.com`;
  const api = await signedUp(email);
  const enabled = await api.post("/api/auth/two-factor/enable", { data: { password: PASSWORD } });
  const { totpURI } = (await enabled.json()) as { totpURI: string };
  const confirmed = await api.post("/api/auth/two-factor/verify-totp", {
    data: { code: totpCode(totpURI) },
  });
  expect(confirmed.ok()).toBe(true);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByRole("textbox", { name: "Code" }).fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert")).toContainText("isn’t right");
  await page.getByRole("textbox", { name: "Code" }).fill(totpCode(totpURI));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(`${base}/`);
  await expect(page.locator(".workspace-sidebar")).toBeVisible();
});

test("accept an invitation as a new person", async ({ page }) => {
  const owner = await request.newContext({
    baseURL: base,
    storageState: E2E_STATE,
    extraHTTPHeaders: { origin: base },
  });
  const email = `guest-${Date.now()}@example.com`;
  const invited = await owner.post("/api/auth/organization/invite-member", {
    data: { email, role: "viewer" },
  });
  expect(invited.ok()).toBe(true);
  const { link, organizationId } = (await invited.json()) as {
    link: string;
    organizationId: string;
  };
  await page.goto(link);
  await expect(page.getByRole("heading", { name: /^Join / })).toBeVisible();
  await expect(page.locator(".auth-facts")).toContainText("owner@highkey-e2e.test");
  await expect(page.locator(".auth-facts")).toContainText("Viewer");
  await page.getByRole("link", { name: "Create your account" }).click();
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByLabel("Name").fill("Guest");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/join\//);
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page).toHaveURL(`${base}/`);
  expect(await activeOrganization(page)).toBe(organizationId);
});

test("connect an agent with read-only access", async ({ browser }) => {
  // A registered agent (as a CIMD client would be once discovered), written straight into the
  // e2e dashboard's database: the test cannot serve a public metadata document.
  const clientId = `highkey-e2e-agent-${Date.now()}`;
  const redirect = "http://127.0.0.1:33418/callback";
  const resource = `${base}/mcp`;
  const db = new Database(
    join(process.cwd(), ".tako", "e2e", process.env.HIGHKEY_E2E_RUN as string, "state.sqlite"),
  );
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO "oauthClient" (id, "clientId", disabled, scopes, "clientCredentialsScopes", "createdAt", "updatedAt", name, "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "dpopBoundAccessTokens")
     VALUES (?, ?, 0, ?, '[]', ?, ?, 'Test agent', ?, 'none', ?, '["code"]', 0)`,
    [
      crypto.randomUUID(),
      clientId,
      JSON.stringify(["openid", "profile", "offline_access", "mcp:read", "mcp:write"]),
      now,
      now,
      JSON.stringify([redirect]),
      JSON.stringify(["authorization_code", "refresh_token"]),
    ],
  );
  db.run(
    `INSERT INTO "oauthClientResource" (id, "clientId", "resourceId", "createdAt") VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), clientId, resource, now],
  );
  db.close();
  const context = await browser.newContext({ storageState: E2E_STATE });
  const page = await context.newPage();
  await page.route(`${redirect}**`, (route) => route.fulfill({ status: 200, body: "connected" }));
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: "openid offline_access mcp:read mcp:write",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e",
    resource,
  });
  await page.goto(`/api/auth/oauth2/authorize?${query}`);
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connect Test agent" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Read only/ })).toBeChecked();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(`${redirect}**`);
  const code = new URL(page.url()).searchParams.get("code") as string;
  expect(code).toBeTruthy();
  const tokens = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(tokens.status).toBe(200);
  const { access_token } = (await tokens.json()) as { access_token: string };
  const listed = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const names = (
    (await listed.json()) as { result: { tools: { name: string }[] } }
  ).result.tools.map((tool) => tool.name);
  expect(names).toContain("describe_project");
  expect(names).not.toContain("save_dashboard");
  await context.close();
});
