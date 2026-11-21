import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";
test("website tiles compare whole sessions, render net revenue bars, and explain Off at source scope", async ({
  page,
}) => {
  const base = process.env.HIGHKEY_API_URL;
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const p = await post("products", { name: `Website tiles ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { kind: "server", label: "Checkout" });
  await post(
    "ingest",
    {
      events: [
        {
          event_id: crypto.randomUUID(),
          name: "page_view",
          source: "server",
          actor_id: "a",
          identity_kind: "visitor",
          session_id: "s",
          properties: { revenue: 1400 },
        },
      ],
    },
    { "content-type": "application/json", authorization: `Bearer ${key}` },
  );
  await page.goto(`/projects/${p.slug}?source=all&metric=web_sessions`);
  const tiles = page.getByRole("region", { name: "Website metrics" });
  await expect(
    tiles
      .getByRole("article")
      .filter({ has: page.getByRole("button", { name: "Sessions", exact: true }) })
      .locator(".widget-value"),
  ).toHaveText("1");
  await tiles.getByRole("button", { name: "Revenue", exact: true }).click();
  await expect(page.locator(".activity-widget .widget-value")).toHaveText("1,400 ¢");
  await expect(page.locator('.activity-widget svg[aria-label^="Revenue by UTC"]')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${p.slug}?source=${p.sources[0].slug}&metric=web_bounce_rate`);
  await expect(
    tiles
      .getByRole("article")
      .filter({ has: page.getByRole("button", { name: "Bounce rate", exact: true }) }),
  ).toContainText("Visitor counting is off for this source");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
