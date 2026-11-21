import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";
test("configure a write-only destination and a dashboard rule, then follow its history", async ({
  page,
}) => {
  test.setTimeout(150000);
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${process.env.HIGHKEY_API_URL}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const p = await post("products", { name: `Notice ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { label: "CLI" });
  await page.goto(`/owner/${p.slug}/settings`);
  await page.getByRole("button", { name: "New destination" }).click();
  let d = page.getByRole("dialog");
  await d.getByLabel("Name", { exact: true }).fill("Unused hook");
  await d.getByLabel("Webhook URL").fill("https://example.com/unused");
  await d.getByRole("button", { name: "Save destination" }).click();
  await expect(d).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New rule" }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("Name", { exact: true }).fill("Release rule");
  await d.getByLabel("Event or @custom event").fill("released");
  await d.getByLabel("Message template").fill("Released {{properties.version}}");
  await d.getByRole("button", { name: "Save rule" }).click();
  await expect(d).toHaveCount(0);
  await post(
    "ingest",
    {
      event_id: crypto.randomUUID(),
      name: "released",
      source: "cli",
      profile_id: "release-owner",
      properties: { version: "v2" },
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByText("Released v2", { exact: true }) });
  await expect(row).toBeVisible({ timeout: 115000 });
  await expect(row.getByRole("link", { name: "View profile" })).toHaveAttribute(
    "href",
    /release-owner/,
  );
  await row.getByRole("link", { name: "View event" }).click();
  await expect(page).toHaveURL(/events.*event.id/);
  await expect(page.getByText("released", { exact: true }).first()).toBeVisible();
});
