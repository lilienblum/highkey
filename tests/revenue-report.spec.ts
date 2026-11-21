import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";

test("revenue groups committed payments and refunds by source, page, profile and session", async ({
  page,
}) => {
  const api = process.env.HIGHKEY_API_URL!;
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const result = await fetch(`${api}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(result.status).toBe(200);
    return result.json();
  };
  const p = await post("products", { name: `Shop ${Date.now()}`, retention_days: 30 });
  const key = await post(`products/${p.id}/keys`, { label: "Payments", kind: "server" });
  const headers = { "content-type": "application/json", authorization: `Bearer ${key.key}` };
  await post(
    "ingest",
    {
      events: [
        {
          name: "purchase",
          properties: { revenue: 2950, path: "/checkout" },
          actor_id: "visitor",
          identity_kind: "visitor",
          session_id: "visit-1",
          profile_id: "buyer",
        },
        { name: "refund", properties: { revenue: -350 } },
      ].map((e) => ({ ...e, event_id: crypto.randomUUID(), source: "server" })),
    },
    headers,
  );
  await page.goto(`/projects/${p.slug}`);
  await page.getByRole("link", { name: "Revenue", exact: true }).click();
  const report = page.getByRole("region", { name: "Revenue report" });
  await expect(report.locator("strong")).toHaveText("2,600");
  await expect(report.getByRole("table", { name: "Revenue by source" })).toContainText("2,600");
  for (const [dimension, label] of [
    ["Page", "/checkout"],
    ["Profile", "buyer"],
    ["Session", "visit-1"],
  ]) {
    await report.getByRole("combobox", { name: "Group revenue by" }).click();
    await page.getByRole("option", { name: dimension, exact: true }).click();
    await expect(report.getByRole("row").filter({ hasText: label })).toContainText("2,950");
    await expect(report.getByRole("row").filter({ hasText: "Unattributed" })).toContainText("-350");
  }
  await page.reload();
  await expect(report.getByRole("table", { name: "Revenue by session" })).toContainText("visit-1");
  await page.screenshot({ path: test.info().outputPath("revenue-report-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(report.getByRole("cell", { name: "-350" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("revenue-report-mobile.png") });
});
