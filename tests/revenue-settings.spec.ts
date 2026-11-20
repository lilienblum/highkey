import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";

test("revenue stays opt-in and server keys never enter browser integration snippets", async ({
  page,
}) => {
  const api = process.env.HIGHKEY_API_URL!;
  const response = await fetch(`${api}/api/products`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ name: `Revenue ${Date.now()}`, retention_days: 30 }),
  });
  expect(response.ok).toBe(true);
  const project = await response.json();
  await page.addInitScript((id) => localStorage.setItem("highkey:product", id), project.id);
  await page.goto("/settings");
  const toggle = page.getByRole("switch", { name: "Allow browser revenue" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("combobox", { name: "Key type", exact: true }).click();
  await page.getByRole("option", { name: "Secret server", exact: true }).click();
  await page.getByLabel("New key label").fill("Payments");
  const created = page.waitForResponse(
    (r) => r.url().endsWith(`/products/${project.id}/keys`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create ingestion key", exact: true }).click();
  const key = await (await created).json();
  expect(key.key.startsWith("sk_")).toBe(true);
  await expect(page.locator(".new-key")).toHaveText(key.key);
  const row = page.locator(".key-row").filter({ hasText: "Payments" });
  await expect(row).toContainText("Secret server key");
  await expect(row.getByRole("button", { name: /origin/i })).toHaveCount(0);
  const integration = page.locator(".integration-card");
  await expect(integration.getByRole("tab", { name: "Browser", exact: true })).toHaveCount(0);
  await expect(integration.getByRole("tab", { name: "Rust CLI", exact: true })).toHaveCount(0);
  await expect(integration.locator(".integration-code")).toContainText("HIGHKEY_SERVER_KEY");
  await expect(integration.locator(".integration-code")).not.toContainText(key.key);
  await page.screenshot({
    path: test.info().outputPath("revenue-settings-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("revenue-settings-mobile.png"),
    fullPage: true,
  });
  await row.getByRole("button", { name: "Revoke Payments", exact: true }).click();
  await page.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(row).toContainText("Revoked");
  await expect(page.locator(".new-key")).toHaveCount(0);
  await page.reload();
  await expect(toggle).not.toBeChecked();
});
