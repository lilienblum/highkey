import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";

test("sessions remember columns and open a visit with its events, AI calls and correlated logs", async ({
  page,
}) => {
  const api = process.env.HIGHKEY_API_URL!;
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${api}/api/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const p = await post("products", { name: `Visits ${Date.now()}`, retention_days: 30 });
  const { key } = await post(`products/${p.id}/keys`, { label: "Server", kind: "server" });
  const log = await post(`products/${p.id}/logs/keys`, { label: "App" });
  const headers = (key: string) => ({
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  });
  const now = Date.now() - 60000;
  const event = (at: number, name: string, properties: object) => ({
    event_id: crypto.randomUUID(),
    name,
    source: "server",
    actor_id: "v",
    session_id: "visit-1",
    identity_kind: "visitor",
    profile_id: "buyer",
    timestamp: new Date(now + at).toISOString(),
    properties,
  });
  const trace = crypto.randomUUID().replaceAll("-", "");
  await post(
    "ingest",
    {
      events: [
        event(0, "page_view", { path: "/docs", referrer: "example.test", order_id: 7 }),
        event(1000, "ai_generation", {
          model: "session-test",
          cost: 0.02,
          currency: "USD",
          trace_id: trace,
        }),
        event(1500, "purchase", { revenue: 250, order_id: 7, request_id: "payment-7" }),
      ],
    },
    headers(key),
  );
  await post(
    "logs/ingest",
    {
      logs: [
        {
          log_id: crypto.randomUUID(),
          timestamp: new Date(now + 500).toISOString(),
          service: "api",
          level: "info",
          message: "Related payment log",
          trace_id: trace,
          request_id: "payment-7",
        },
      ],
    },
    headers(log.key),
  );
  await page.goto(`/projects/${p.slug}/sessions`);
  const table = page.getByRole("table", { name: "Sessions", exact: true });
  await expect(table).toContainText("250");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Referrer", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(table.getByRole("columnheader", { name: "Referrer" })).toBeVisible();
  await page.getByLabel("Path or referrer").fill("no match");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("No sessions match", { exact: false })).toBeVisible();
  await page.getByLabel("Path or referrer").fill("/docs");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await table.getByRole("button", { name: "visit-1" }).click();
  await expect(page.getByRole("region", { name: "Session timeline" })).toContainText(
    "session-test",
  );
  await expect(page.getByRole("region", { name: "Related logs" })).toContainText(
    "Related payment log",
  );
  await page.screenshot({ path: test.info().outputPath("session-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "View AI trace" }).click();
  const ai = page.getByRole("region", { name: "AI cost report" });
  await expect(ai.getByRole("table", { name: "AI generations" })).toContainText("session-test");
  await expect(ai).toContainText("1 of 1 calls reported a cost");
  await ai.getByRole("combobox", { name: "Group AI costs by" }).click();
  await page.getByRole("option", { name: "Profile", exact: true }).click();
  await expect(ai.getByRole("table", { name: "AI cost breakdown" })).toContainText("buyer");
  await page.goBack();
  await page.goBack();
  await page.getByRole("link", { name: "buyer", exact: true }).click();
  const profile = page.getByRole("region", { name: "Profile detail" });
  await expect(profile).toContainText("Revenue (cents)");
  await expect(profile).toContainText("250");
  await profile.getByRole("tab", { name: "Sessions", exact: true }).click();
  await profile.getByRole("link", { name: /visit-1/ }).click();
  await expect(page.getByRole("heading", { name: "Session detail" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("session-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(table).toContainText("visit-1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`/projects/${p.slug}/events`);
  await page.getByRole("button", { name: "Inspect purchase", exact: true }).click();
  let inspector = page.getByRole("dialog");
  await expect(inspector.getByRole("link", { name: /1 page view · 3 events/ })).toBeVisible();
  await inspector.getByRole("button", { name: "Follow order_id", exact: true }).click();
  const stream = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Event", exact: true }) });
  await expect(stream.getByRole("row").nth(1)).toContainText("page_view");
  await expect(stream.getByRole("row").nth(2)).toContainText("purchase");
  await page.getByRole("button", { name: "Inspect purchase", exact: true }).click();
  inspector = page.getByRole("dialog");
  await inspector.getByRole("link", { name: "Logs for this request" }).click();
  await expect(page.getByLabel("Request ID", { exact: true })).toHaveValue("payment-7");
  await expect(page.locator(".log-row")).toContainText("Related payment log");
});
