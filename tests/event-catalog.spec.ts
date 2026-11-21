import { test, expect } from "@playwright/test";
import { apiHeaders } from "./auth";

test("an event definition decorates the stream and counts conversions across the project", async ({
  page,
}) => {
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${process.env.HIGHKEY_API_URL}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok).toBe(true);
    return r.json();
  };
  const project = await post("products", { name: `Catalog ${Date.now()}`, retention_days: 30 });
  const { key } = await post(`products/${project.id}/keys`, { label: "Orders" });
  await post(
    "ingest",
    {
      name: "shipped",
      source: "server",
      event_id: crypto.randomUUID(),
      properties: { order_id: 7 },
    },
    { "content-type": "application/json", authorization: `Bearer ${key}` },
  );
  await page.goto(`/projects/${project.slug}/events`);
  await expect(page.getByRole("button", { name: "Inspect shipped" })).toBeVisible();
  await page.getByRole("button", { name: "Event catalog", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Edit shipped" }).click();
  await dialog.getByLabel("Sentence template").fill("Order {order_id} shipped");
  await dialog.getByRole("switch", { name: "Count as a conversion" }).click();
  await dialog.getByRole("button", { name: "Save definition" }).click();
  await dialog.getByRole("tab", { name: "Conversions", exact: true }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("shipped");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Inspect shipped" })).toContainText(
    "Order 7 shipped",
  );
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Conversions", exact: true }).locator(".widget-value"),
  ).toHaveText("1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.slug}/events`);
  await page.getByRole("button", { name: "Event catalog", exact: true }).click();
  await dialog.getByRole("button", { name: "New custom event" }).click();
  await dialog.getByLabel("Event name", { exact: true }).fill("paid_order");
  await dialog.getByLabel("Raw event 1", { exact: true }).fill("shipped");
  await dialog.getByRole("button", { name: "Add filter", exact: true }).click();
  await dialog.getByLabel("Property 1.1", { exact: true }).fill("order_id");
  await dialog.getByLabel("Value 1.1", { exact: true }).fill("7");
  await dialog.getByRole("button", { name: "Save definition" }).click();
  await expect(dialog.getByRole("button", { name: "Edit @paid_order" })).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Event", exact: true }).click();
  await page.getByRole("option", { name: "@paid_order", exact: true }).click();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page).toHaveURL(/paid_order/);
  await expect(page.getByRole("button", { name: "Inspect shipped" })).toBeVisible();
});
