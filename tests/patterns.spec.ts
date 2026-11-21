import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";

test("from Overview and Events, inspect a weekly pattern and follow the paths before a page", async ({
  page,
}) => {
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const res = await fetch(`${process.env.HIGHKEY_API_URL}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    return res.json();
  };
  const p = await post("products", { name: `Pattern ${Date.now()}`, retention_days: 30 });
  const { key } = await post(`products/${p.id}/keys`, { label: "Site" });
  await post(
    "ingest",
    {
      events: ["/", "/cart", "/thanks"].map((path, i) => ({
        event_id: crypto.randomUUID(),
        name: "page_view",
        source: "web",
        timestamp: new Date(Date.now() - 30000 + i * 1000).toISOString(),
        actor_id: "v",
        session_id: "s",
        identity_kind: "visitor",
        properties: { path },
      })),
    },
    { "content-type": "application/json", authorization: `Bearer ${key}` },
  );
  await page.goto(`/projects/${p.slug}`);
  await page.getByRole("button", { name: "Analyze patterns" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("table")).toHaveAccessibleName(/Visitors by weekday/);
  await dialog.getByRole("tab", { name: "Page flow" }).click();
  await dialog.getByLabel("To page", { exact: true }).fill("/thanks");
  await dialog.getByLabel("Steps", { exact: true }).fill("2");
  await dialog.getByRole("button", { name: "Apply path" }).click();
  await dialog.getByText("Paths and session counts").click();
  await expect(dialog.getByRole("listitem")).toHaveText("/cart → /thanks · 1");
  await page.screenshot({ path: test.info().outputPath("page-flow-desktop.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${p.slug}/events`);
  await page.getByRole("button", { name: "Analyze patterns" }).click();
  await dialog.getByRole("tab", { name: "Distribution" }).click();
  await expect(dialog.getByText("Events per identified actor in this selection")).toBeVisible();
  await expect(dialog.locator("dd").nth(2)).toHaveText("1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("distribution-mobile.png") });
});
