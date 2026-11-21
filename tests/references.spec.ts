import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";
test("chart point notes persist across Settings and Overview; viewers can follow the point's UTC range", async ({
  page,
}) => {
  const base = process.env.HIGHKEY_API_URL;
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const res = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    return res.json();
  };
  const p = await post("products", { name: `Timeline ${Date.now()}`, retention_days: 30 });
  const { key } = await post(`products/${p.id}/keys`, { label: "Release" });
  await post(
    "ingest",
    {
      events: [
        {
          event_id: crypto.randomUUID(),
          name: "deploy",
          profile_id: "release-manager",
          source: "cli",
          properties: { version: "1.2.3" },
        },
        {
          event_id: crypto.randomUUID(),
          name: "launch",
          profile_id: "other-profile",
          source: "cli",
        },
      ],
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  await page.goto(`/projects/${p.slug}`);
  const chart = page.locator(".activity-widget svg.ts-chart");
  await chart.press("End");
  await chart.press("Enter");
  const point = page.getByRole("dialog", { name: "Chart point" });
  await expect(point.getByText("Deploy 1.2.3", { exact: true })).toBeVisible();
  await point.getByRole("button", { name: "Add reference" }).click();
  await page.getByLabel("Title", { exact: true }).fill("New onboarding");
  await page.getByRole("button", { name: "Save reference" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(`/projects/${p.slug}/settings`);
  await expect(page.getByText(/New onboarding/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const search = new URLSearchParams({
    filter: JSON.stringify({ field: "name", value: "deploy" }),
  });
  await page.goto(`/owner/${p.slug}?${search}`);
  await chart.press("End");
  await chart.press("Enter");
  await expect(point.getByText("New onboarding")).toBeVisible();
  await point.getByRole("link", { name: "View users" }).click();
  await expect(page).toHaveURL(/\/people\?.*from=/);
  const profiles = page.getByRole("table", { name: "Profiles" });
  await expect(profiles.getByRole("link", { name: "release-manager", exact: true })).toBeVisible();
  await expect(profiles.getByRole("link", { name: "other-profile", exact: true })).toHaveCount(0);
});
