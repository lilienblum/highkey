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
        event(0, "page_view", { path: "/docs", referrer: "example.test" }),
        event(1000, "ai_generation", {
          model: "session-test",
          cost: 0.02,
          currency: "USD",
          trace_id: trace,
        }),
        event(1500, "purchase", { revenue: 250 }),
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
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("session-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(table).toContainText("visit-1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
