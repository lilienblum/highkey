import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";
test("Realtime uses its rolling window, shows new activity, and can leave TV mode", async ({
  page,
}) => {
  const url = process.env.HIGHKEY_API_URL;
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${url}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const p = await post("products", { name: `Live ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { label: "Site" });
  await page.goto(`/owner/${p.slug}/realtime`);
  await expect(page.getByText("No recent events.")).toBeVisible();
  await post(
    "ingest",
    {
      events: [
        {
          event_id: crypto.randomUUID(),
          name: "page_view",
          source: "web",
          actor_id: "v",
          session_id: "s",
          identity_kind: "visitor",
          properties: { path: "/live-demo" },
        },
      ],
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  await expect(page.getByText("1 events in the last 30 minutes")).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole("link", { name: /live-demo.*1 views/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose date range" })).toHaveCount(0);
  await page.getByRole("button", { name: "TV mode", exact: true }).click();
  await page.getByRole("button", { name: "Exit TV mode" }).click();
  await page.getByRole("link", { name: /live-demo.*1 views/ }).click();
  await expect(page).toHaveURL(/\/sessions\?/);
});
