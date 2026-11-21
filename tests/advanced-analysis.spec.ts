import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";
test("save and reopen an ad-hoc funnel, inspect its drop-off, then compare retention and conversion", async ({
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
  const p = await post("products", { name: `Analysis ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { label: "App" });
  const t = Date.now() - 60000;
  await post(
    "ingest",
    {
      events: ["start", "paid", "start"].map((name, i) => ({
        event_id: crypto.randomUUID(),
        timestamp: new Date(t + i * 1000).toISOString(),
        name,
        source: "cli",
        actor_id: i === 2 ? "b" : "a",
        identity_kind: "actor",
        profile_id: i === 2 ? "b" : "a",
        properties: { plan: "pro" },
      })),
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  await page.goto(`/owner/${p.slug}/events`);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Explore analysis" });
  await d.getByLabel("Ordered events").fill("start,paid");
  await d.getByRole("button", { name: "Run analysis" }).click();
  await d.getByRole("button", { name: "1 · largest drop" }).click();
  await expect(d.getByRole("link", { name: "b", exact: true })).toBeVisible();
  await d.getByRole("button", { name: "Back to funnel" }).click();
  await d.getByLabel("Analysis view name").fill("Path to paid");
  await d.getByRole("button", { name: "Save analysis view" }).click();
  await expect(d.getByLabel("Saved analyses")).toContainText("Path to paid");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await d.getByLabel("Saved analyses").click();
  await page.getByRole("option", { name: "Path to paid" }).click();
  await expect(d.getByRole("table", { name: "Funnel steps" })).toBeVisible();
  for (const [mode, role, label] of [
    ["Conversion over time", "img", "Conversion, previous period and weighted average"],
    ["Retention", "table", "Retention cohorts"],
  ] as const) {
    await d.getByLabel("Analysis type").click();
    await page.getByRole("option", { name: mode, exact: true }).click();
    if (mode === "Retention") {
      await d.getByLabel("Start events").fill("start");
      await d.getByLabel("Return events").fill("paid");
    }
    await d.getByRole("button", { name: "Run analysis" }).click();
    await expect(d.getByRole(role, { name: label })).toBeVisible();
  }
  expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
