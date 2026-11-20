// Settings for people, keys, agents and accounts, and the server admin's page.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { expect, type Page, request, test } from "@playwright/test";
import { totpCode } from "../apps/app/test/totp";
import { E2E_DATABASE } from "./auth";

const base = process.env.HIGHKEY_DASHBOARD_URL as string;
const PASSWORD = "a long enough password";
const run = Date.now();

async function account(email: string) {
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const signed = await api.post("/api/auth/sign-up/email", {
    data: { name: email.split("@")[0], email, password: PASSWORD },
  });
  expect(signed.ok()).toBe(true);
  return api;
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("invite a member, change the role, remove them", async ({ page, browser }) => {
  const email = `teammate-${run}@example.com`;
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill(email);
  await choose(page, "Role", "Viewer");
  await page.getByRole("button", { name: "Invite" }).click();
  const link = await page.locator(".invite-link code").textContent();
  expect(link).toContain("/join/");
  await expect(page.getByRole("cell", { name: email, exact: true })).toBeVisible();
  // They join from the link.
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const joining = await guest.newPage();
  await joining.goto(link as string);
  await joining.getByRole("link", { name: "Create your account" }).click();
  // The form is ready once its button is (it waits for the page to hydrate).
  await expect(joining.getByRole("button", { name: "Create account" })).toBeEnabled();
  await joining.getByLabel("Name").fill("Teammate");
  await joining.getByLabel("Password").fill(PASSWORD);
  await joining.getByRole("button", { name: "Create account" }).click();
  await expect(joining).toHaveURL(/\/join\//);
  await joining.getByRole("button", { name: "Accept" }).click();
  await expect(joining).toHaveURL(new RegExp(`^${base}/`));
  await guest.close();
  await page.reload();
  const role = page.getByRole("combobox", { name: `Role of ${email}` });
  await expect(role).toContainText("Viewer");
  await choose(page, `Role of ${email}`, "Member");
  await expect(role).toContainText("Member");
  await page.reload();
  await expect(page.getByRole("combobox", { name: `Role of ${email}` })).toContainText("Member");
  await page.getByRole("button", { name: `Remove ${email}` }).click();
  await expect(page.getByRole("cell", { name: email, exact: true })).toHaveCount(0);
});

test("create a read key, use it, revoke it", async ({ page }) => {
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: "New API key" }).click();
  await page.getByLabel("Name").fill(`Wallboard ${run}`.slice(0, 32));
  await page.getByRole("button", { name: "Create key" }).click();
  const key = (await page.locator(".settings-secret code").textContent()) as string;
  expect(key.startsWith("hk_")).toBe(true);
  const read = () =>
    fetch(`${base}/api/read/products`, { headers: { authorization: `Bearer ${key}` } });
  expect((await read()).status).toBe(200);
  const write = await fetch(`${base}/api/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Nope", retention_days: 30 }),
  });
  expect(write.status).toBe(403);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `Revoke Wallboard ${run}`.slice(0, 39) }).click();
  await expect.poll(async () => (await read()).status).toBe(401);
});

test("revoke an agent connection", async ({ page }) => {
  const clientId = `settings-agent-${run}`;
  const redirect = "http://127.0.0.1:33419/callback";
  const resource = `${base}/mcp`;
  const db = new Database(E2E_DATABASE, { create: false });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO "oauthClient" (id, "clientId", disabled, scopes, "clientCredentialsScopes", "createdAt", "updatedAt", name, "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "dpopBoundAccessTokens")
     VALUES (?, ?, 0, ?, '[]', ?, ?, 'Settings agent', ?, 'none', ?, '["code"]', 0)`,
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
  await page.route(`${redirect}**`, (route) => route.fulfill({ status: 200, body: "ok" }));
  const verifier = randomBytes(32).toString("base64url");
  await page.goto(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: "openid offline_access mcp:read",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "s",
      resource,
    })}`,
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(`${redirect}**`);
  const code = new URL(page.url()).searchParams.get("code") as string;
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
  const { access_token } = (await tokens.json()) as { access_token: string };
  const mcp = () =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  expect((await mcp()).status).toBe(200);
  await page.goto("/settings/agents");
  await expect(page.getByRole("cell", { name: "Settings agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke Settings agent" }).click();
  await expect(page.getByRole("cell", { name: "Settings agent", exact: true })).toHaveCount(0);
  expect((await mcp()).status).toBe(401);
});

test("turn on two-factor", async ({ browser }) => {
  const api = await account(`careful-settings-${run}@example.com`);
  const context = await browser.newContext({ storageState: await api.storageState() });
  const page = await context.newPage();
  await page.goto("/settings/account");
  await page.getByLabel("Password", { exact: true }).first().fill(PASSWORD);
  await page.getByRole("button", { name: "Set up two-factor codes" }).click();
  const key = ((await page.getByTestId("totp-setup-key").textContent()) as string).replace(
    /\s+/g,
    "",
  );
  await page.getByLabel("Code from the app").fill(totpCode(`otpauth://totp/x?secret=${key}`));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("On. Signing in asks for a code")).toBeVisible();
  await context.close();
});

test("the server admin bans a user", async ({ page }) => {
  const email = `troublemaker-${run}@example.com`;
  await account(email);
  await page.goto("/admin");
  await page.getByRole("searchbox", { name: "Search people and organizations" }).fill(email);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: `Actions for ${email}` }).click();
  await page.getByRole("menuitem", { name: "Ban" }).click();
  await expect(page.getByText("Banned")).toBeVisible();
  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(signIn.status).toBe(403);
});
