import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";
test("website entry tabs, typed row filters and a verified plain-English date/device change", async ({
  page,
}, info) => {
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${process.env.HIGHKEY_API_URL}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const p = await post("products", { name: `Web reports ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { kind: "server", label: "Events" });
  const at = Date.now() - 30000;
  await post(
    "ingest",
    {
      events: ["/start", "/pay"].map((path, i) => ({
        name: "page_view",
        event_id: crypto.randomUUID(),
        timestamp: new Date(at + i * 1000).toISOString(),
        source: "web",
        actor_id: "a",
        identity_kind: "visitor",
        session_id: "s",
        properties: { path },
      })),
    },
    {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Version/17.2 Mobile Safari/605.1",
    },
  );
  await page.goto(`/owner/${p.slug}?source=all&metric=web_page_views`);
  const pages = page.getByRole("region", { name: "Pages", exact: true });
  await pages.getByRole("tab", { name: "Entry", exact: true }).click();
  await expect(pages.getByRole("button", { name: "/start", exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "/pay", exact: true })).toHaveCount(0);
  await pages.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("website-tabs-desktop.png") });
  await pages.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("table", { name: "Pages: Entry report" })).toContainText("/start");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await pages.getByRole("button", { name: "/start", exact: true }).click();
  await expect(page.getByRole("region", { name: "Applied filter" })).toContainText("/start");
  await page.getByRole("button", { name: "Describe filter" }).click();
  await page.getByLabel("Filter phrase").fill("last 7 days, mobile only");
  await page.screenshot({ path: info.outputPath("describe-filter-mobile.png") });
  await page.getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(page.getByRole("region", { name: "Applied filter" })).toContainText("Mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
