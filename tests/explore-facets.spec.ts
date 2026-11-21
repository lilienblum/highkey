import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";
test("filter suggestions keep dotted keys and typed values; an empty filter needs no input", async ({
  page,
}) => {
  const url = process.env.HIGHKEY_API_URL;
  async function post(path: string, body: object, headers = apiHeaders()) {
    const r = await fetch(`${url}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  }
  const p = await post("products", { name: `Property picker ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { label: "Test" });
  await post(
    "ingest",
    {
      events: [
        {
          event_id: crypto.randomUUID(),
          name: "launch",
          source: "cli",
          groups: { team: "orbit" },
          profile_id: "ada",
          properties: { "app.version": "01" },
        },
        { event_id: crypto.randomUUID(), name: "launch", source: "cli", properties: {} },
      ],
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  await page.goto(`/owner/${p.slug}/events`);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Property", { exact: true }).fill("app.version");
  await expect(page.locator("#observed-values option")).toHaveAttribute("value", '"01"');
  await page.getByLabel("Condition", { exact: true }).click();
  await page.getByRole("option", { name: "is empty", exact: true }).click();
  await expect(page.getByLabel("Typed value")).toBeDisabled();
  const result = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/${p.id}/query`) && r.request().postDataJSON().filters?.[0]?.op === "empty",
  );
  await page.getByRole("button", { name: "Run query" }).click();
  expect((await (await result).json()).summary.total).toBe(1);
  await page.goto(`/owner/${p.slug}/people`);
  await page.getByRole("tab", { name: "Groups", exact: true }).click();
  await page.getByRole("link", { name: "orbit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New members over time" })).toBeVisible();
  await page.getByRole("link", { name: "ada", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ada", exact: true })).toBeVisible();
});
