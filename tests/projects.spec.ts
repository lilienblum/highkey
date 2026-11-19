// Deleting, restoring and moving projects from settings.
import { expect, request, test } from "@playwright/test";
import { apiHeaders } from "./auth";

const base = process.env.HIGHKEY_DASHBOARD_URL as string;
const run = Date.now();

test("delete a project, then restore it from the organization's settings", async ({ page }) => {
  const created = (await (
    await fetch(`${base}/api/products`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ name: `Short-lived ${run}`, retention_days: 30 }),
    })
  ).json()) as { id: string; slug: string; name: string };
  await page.goto(`/owner/${created.slug}/settings`);
  const remove = page.getByRole("button", { name: "Delete project" });
  await expect(remove).toBeDisabled();
  await page.getByLabel(`Type “${created.name}” to confirm`).fill(created.name);
  await remove.click();
  await expect(page).not.toHaveURL(new RegExp(created.slug));
  await expect(page).toHaveURL(new RegExp(`^${base}/owner(/|$)`));
  // An admin restores it within 7 days.
  await page.goto("/settings/organization");
  const restore = page.getByRole("button", { name: `Restore ${created.name}` });
  await expect(restore).toBeVisible();
  await restore.click();
  await expect(restore).toHaveCount(0);
  await page.goto(`/owner/${created.slug}`);
  await expect(page.locator(".workspace-project")).toContainText(created.name);
});

test("move a project to another organization", async ({ browser }) => {
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  expect(
    (
      await api.post("/api/auth/sign-up/email", {
        data: {
          name: `Mover ${run}`,
          email: `mover-${run}@example.com`,
          password: "a long enough password",
        },
      })
    ).ok(),
  ).toBe(true);
  const session = (await (await api.get("/api/auth/get-session")).json()) as {
    session: { activeOrganizationId: string };
  };
  const home = (
    (await (await api.get("/api/auth/organization/list")).json()) as { id: string; slug: string }[]
  ).find((org) => org.id === session.session.activeOrganizationId) as { id: string; slug: string };
  expect(
    (
      await api.post("/api/auth/organization/create", {
        data: { name: `Elsewhere ${run}`, slug: `elsewhere-${run}` },
      })
    ).ok(),
  ).toBe(true);
  await api.post("/api/auth/organization/set-active", { data: { organizationId: home.id } });
  const project = (await (
    await api.post("/api/products", { data: { name: `Wanderer ${run}`, retention_days: 30 } })
  ).json()) as { slug: string; name: string };
  const context = await browser.newContext({ storageState: await api.storageState() });
  const page = await context.newPage();
  await page.goto(`/${home.slug}/${project.slug}/settings`);
  await page.getByRole("combobox", { name: "Move to", exact: true }).click();
  await page.getByRole("option", { name: `Elsewhere ${run}`, exact: true }).click();
  await page.getByRole("button", { name: "Move project" }).click();
  await expect(page).toHaveURL(`${base}/elsewhere-${run}/${project.slug}/settings`);
  await expect(page.locator(".organization-trigger")).toContainText(`Elsewhere ${run}`);
  await expect(page.locator(".workspace-project")).toContainText(project.name);
  await context.close();
});
