import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { apiHeaders } from "./auth";

const endpoint = process.env.HIGHKEY_API_URL;
test("several websites and wildcard subdomains persist, fill key origins, and can be cleared", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project name").fill(`Website settings ${Date.now()}`);
  await dialog
    .getByLabel("Websites", { exact: true })
    .fill("*.example.com,\nhttp://127.0.0.1/private-path\nexample.com");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const sites = page.getByLabel("Websites", { exact: true });
  const list = ["https://*.example.com", "http://127.0.0.1", "https://example.com"];
  await expect(sites).toHaveValue(list.join("\n"));
  await expect(page.getByText(/No supported favicon found/)).toBeVisible();
  await page.getByRole("button", { name: "Use project websites" }).click();
  await expect(page.getByLabel("Allowed origins", { exact: true })).toHaveValue(list.join(", "));
  await page.getByLabel("New key label").fill("Browser sites");
  await page.getByRole("button", { name: "Create ingestion key", exact: true }).click();
  const key = (await page.locator(".new-key").innerText()).trim();
  for (const [origin, status] of [
    ["https://docs.eu.example.com", 200],
    ["https://unrelated.test", 403],
  ] as const) {
    const r = await fetch(`${endpoint}/api/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin },
      body: JSON.stringify({ event_id: crypto.randomUUID(), name: "view", source: "web" }),
    });
    expect(r.status, await r.text()).toBe(status);
  }
  await page.reload();
  await expect(sites).toHaveValue(list.join("\n"));
  await sites.fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Project changes saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use project websites" })).toHaveCount(0);
  await page.reload();
  await expect(sites).toHaveValue("");
});

test("project icons load only from Highkey and failed images fall back without shifting the picker", async ({
  page,
}) => {
  const response = await fetch(`${endpoint}/api/products`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ name: `Cached icon ${Date.now()}`, retention_days: 30 }),
  });
  const project = await response.json();
  await page.addInitScript((id) => localStorage.setItem("highkey:product", id), project.id);
  // The real download/cache boundary is covered by Rust tests. The first catalog renders on the
  // server; the refresh after each Settings save comes from the browser, so it carries the fixture.
  let iconVersion = "cached-test-icon";
  await page.route("**/api/products", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const products = await response.json();
    await route.fulfill({
      json: products.map((p: { id: string }) =>
        p.id === project.id
          ? { ...p, website_url: "https://example.com", favicon_version: iconVersion }
          : p,
      ),
    });
  });
  let fail = false;
  await page.route(`**/api/products/${project.id}/favicon?*`, async (route) => {
    if (fail) await route.fulfill({ status: 404, body: "" });
    else
      await route.fulfill({
        contentType: "image/png",
        body: await readFile(new URL("./fixtures/favicon.png", import.meta.url)),
      });
  });
  const remote: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "image" &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    )
      remote.push(request.url());
  });
  await page.goto("/settings");
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  const picker = page.getByRole("combobox", { name: "Select project", exact: true }).first();
  const image = picker.locator("img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  const before = await picker.boundingBox();
  await picker.click();
  await expect(
    page.getByRole("option", { name: project.name, exact: true }).locator("img"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  fail = true;
  iconVersion = "cached-test-icon-2";
  await save.click();
  await expect(picker).toContainText(project.name);
  await expect(picker.locator("img")).toHaveCount(0);
  const after = await picker.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
  expect(remote).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("combobox", { name: "Select project", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("website-settings-mobile.png"),
    fullPage: true,
  });
  // A background catalog refresh can still be inside route.fetch when the test ends.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
