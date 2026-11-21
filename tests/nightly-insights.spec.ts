import { test, expect } from "@playwright/test";
import { openBunDb } from "../apps/app/src/server/db/bun-db";
import { Readers } from "../apps/app/src/server/clickhouse/access";
import { apiContext } from "../apps/app/src/server/api/context";
import { nightlyProject } from "../apps/app/src/server/insights";
import { E2E_SERVER } from "../scripts/clickhouse";
import { assertIsolatedE2E } from "../scripts/e2e-config";
import { apiHeaders, E2E_DATABASE } from "./auth";

test("a completed day produces the same referrer spike in Insights and on the chart", async ({
  page,
}) => {
  assertIsolatedE2E(process.env);
  const post = async (path: string, body: object, headers = apiHeaders()) => {
    const r = await fetch(`${process.env.HIGHKEY_API_URL}/api/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const p = await post("products", { name: `Spikes ${Date.now()}`, retention_days: 30 }),
    { key } = await post(`products/${p.id}/keys`, { kind: "server", label: "Traffic" });
  // Send live events, then run the same nightly calculation with tomorrow's clock. Historical
  // backfills deliberately do not establish sessions.
  await post(
    "ingest",
    {
      events: Array.from({ length: 12 }, (_, i) => ({
        event_id: crypto.randomUUID(),
        name: "page_view",
        source: "web",
        actor_id: `v${i}`,
        identity_kind: "visitor",
        session_id: "s",
        properties: { referrer: "release.example", path: "/launch" },
      })),
    },
    { authorization: `Bearer ${key}`, "content-type": "application/json" },
  );
  const day = 86400000,
    start = Math.floor(Date.now() / day) * day,
    db = openBunDb(E2E_DATABASE);
  try {
    await nightlyProject(
      {
        ...apiContext(),
        db,
        readers: new Readers({
          url: `http://127.0.0.1:${E2E_SERVER.port}`,
          secret: E2E_SERVER.password,
        }),
        now: () => new Date(start + day + 3600000),
      },
      p.id,
    );
  } finally {
    await db.close();
  }
  const range = new URLSearchParams({
    from: new Date(start).toISOString(),
    to: new Date(start + day).toISOString(),
  });
  await page.goto(`/owner/${p.slug}?${range}`);
  await page.getByRole("button", { name: "Insights", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Project insights" });
  await expect(d.getByText("Referrer spike: release.example", { exact: true })).toBeVisible();
  await expect(d.getByText(/12 sessions vs 0 per day/)).toBeVisible();
  await page.keyboard.press("Escape");
  const chart = page.locator(".activity-widget svg.ts-chart");
  await chart.press("End");
  await chart.press("Enter");
  await expect(page.getByRole("dialog", { name: "Chart point" })).toContainText(
    "Referrer spike: release.example",
  );
});
