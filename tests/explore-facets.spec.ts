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
  await page.goto(`/owner/${p.slug}/people?days=30`);
  await expect(page).toHaveURL((url) => url.pathname.endsWith("/people") && !url.search);
  await expect(page.getByRole("button", { name: "Choose date range" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Groups", exact: true })).toHaveCount(0);
  const groups = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Groups", exact: true });
  await groups.click();
  await expect(page).toHaveURL((url) => url.pathname === `/owner/${p.slug}/groups` && !url.search);
  await expect(groups).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Choose date range" })).toBeVisible();
  await page.getByRole("link", { name: "orbit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New members over time" })).toBeVisible();
  await page.getByRole("link", { name: "ada", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ada", exact: true })).toBeVisible();
  const membership = page.getByRole("link", { name: "team: orbit", exact: true });
  await expect(membership).toHaveAttribute("href", /\/groups\?.*groupId=orbit/);
  await expect(page.getByRole("button", { name: "Choose date range" })).toBeVisible();
  await page.getByRole("button", { name: "Back to profiles" }).click();
  await expect(page.getByRole("button", { name: "Choose date range" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cohorts", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "New cohort" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Launchers");
  await dialog.getByLabel("Event name").fill("launch");
  await dialog.getByRole("button", { name: "Save cohort" }).click();
  await dialog.getByRole("button", { name: "Launchers", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Profiles" }).getByRole("link", { name: "ada" }),
  ).toBeVisible();
  await page.goto(`/owner/${p.slug}/realtime`);
  await page.getByLabel("Report cohort").click();
  await page.getByRole("option", { name: "Launchers" }).click();
  await expect(page.getByText("1 event in the last 30 minutes", { exact: true })).toBeVisible();
  await page.goto(`/owner/${p.slug}/people?kind=groups&groupType=team&groupId=orbit&days=30`);
  await expect(page).toHaveURL(
    (url) =>
      url.pathname.endsWith("/groups") &&
      url.searchParams.get("days") === "30" &&
      !url.searchParams.has("kind"),
  );
  await expect(page.getByRole("link", { name: "ada", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "All groups", exact: true }).click();
  await expect(page.getByRole("table", { name: "Groups", exact: true })).toBeVisible();
});
