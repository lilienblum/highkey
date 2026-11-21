import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";
test("a saved exclusion discards matching payloads before they reach reports", async ({ page }) => {
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
  const p = await post("products", { name: `Exclude ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { label: "Tracker" });
  await page.goto(`/owner/${p.slug}/settings`);
  await page.getByRole("button", { name: "Collection exclusions" }).click();
  const d = page.getByRole("dialog", { name: "Collection exclusions" });
  await d.getByRole("button", { name: "Add event rule" }).click();
  await d.getByLabel("Raw event name").fill("internal");
  await d.getByRole("button", { name: "Save exclusions" }).click();
  await expect(d).toHaveCount(0);
  await post(
    "ingest",
    {
      events: ["internal", "public"].map((name) => ({
        event_id: crypto.randomUUID(),
        name,
        source: "cli",
        properties: {},
      })),
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  const r = await post(`products/${p.id}/query`, {
    from: new Date(Date.now() - 60000).toISOString(),
    to: new Date(Date.now() + 1000).toISOString(),
  });
  expect(r.events.map((e: { name: string }) => e.name)).toEqual(["public"]);
});
