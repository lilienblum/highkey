import { test, expect, type Page } from "@playwright/test";
import { apiHeaders } from "./auth";
// The page is the log stream's only scroll container.
async function scrollToEnd(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
}
const endpoint = process.env.HIGHKEY_API_URL;
if (!endpoint) throw new Error("Run log browser tests through bun test:e2e.");
let project: { id: string; slug: string };
let key: string;
async function admin(path: string, body?: unknown) {
  const response = await fetch(`${endpoint}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: apiHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.ok).toBe(true);
  return response.json();
}
async function ingest(records: unknown[]) {
  const response = await fetch(`${endpoint}/api/logs/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ logs: records }),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
test.beforeAll(async () => {
  project = await admin("/products", {
    name: "Logs fixture",
    retention_days: 30,
  });
  key = (await admin(`/products/${project.id}/logs/keys`, { label: "Test service" })).key;
  for (let start = 0; start < 120; start += 100)
    await ingest(
      Array.from({ length: Math.min(100, 120 - start) }, (_, index) => {
        const i = index + start;
        return {
          log_id: `log-${i}`,
          timestamp: new Date(Date.now() - i * 1000 - 10000).toISOString(),
          level: i % 7 === 0 ? "error" : i % 5 === 0 ? "warn" : "info",
          service: i % 3 === 0 ? "worker" : "api",
          environment: "production",
          message: `GET /api/orders/${1000 + i} completed in ${12 + i}ms`,
          attributes: {
            status: i % 7 === 0 ? 500 : 200,
            success: i % 7 !== 0,
            attempt: i,
            region: "tokyo",
            context: { queue: "orders", tags: ["http", "checkout"] },
          },
        };
      }),
    );
});
test("log explorer filters, inspects, paginates and restores a shared query", async ({ page }) => {
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  expect(await page.locator(".log-row").count()).toBeLessThan(60);
  await expect(page.getByText("120 records", { exact: true })).toBeVisible();
  await page.screenshot({ path: "apps/dashboard/.impeccable/screenshots/logs-desktop.png" });
  await scrollToEnd(page);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 120 of");
  await expect(page.getByRole("button", { name: /older logs/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to newest" }).click();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  expect(await page.locator(".log-row").count()).toBeLessThan(60);
  await page.getByRole("button", { name: "Following", exact: true }).click();
  await page.getByLabel("Search log messages").fill("orders/1000");
  await expect(page.getByText("Changes not applied", { exact: true })).toBeVisible();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  expect(await page.locator(".log-row").count()).toBeLessThan(60);
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByLabel("Search log messages")).toHaveValue("");
  await expect(page.getByText("Changes not applied", { exact: true })).toHaveCount(0);
  await page.getByLabel("Search log messages").fill("orders/1000");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".log-row")).toHaveCount(1);
  await expect(page.getByText("Changes not applied", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Search log messages")).toHaveValue("orders/1000");
  await expect(page.locator(".log-row")).toHaveCount(1);
  await page.locator(".log-row").click();
  const inspector = page.getByRole("dialog");
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("Log details");
  await expect(inspector).toContainText("production");
  await expect(
    inspector.getByRole("button", { name: "tokyo (string)", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "apps/dashboard/.impeccable/screenshots/logs-inspector.png",
    animations: "disabled",
  });
  await inspector.getByRole("tab", { name: "Raw JSON" }).click();
  await expect(inspector).toContainText('"status": 500');
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  await expect(page.locator(".log-row")).toBeFocused();
});
test("following logs refreshes records while retaining an open inspector", async ({ page }) => {
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  expect(await page.locator(".log-row").count()).toBeLessThan(60);
  await page.locator(".log-row").first().click();
  const inspector = page.getByRole("dialog");
  const original = await inspector.textContent();
  await ingest([
    {
      log_id: crypto.randomUUID(),
      service: "api",
      level: "info",
      message: "Live checkout completed",
      attributes: { status: 200 },
    },
  ]);
  await expect(page.locator(".log-row").first()).toContainText("Live checkout completed", {
    timeout: 12000,
  });
  expect(await inspector.textContent()).toBe(original);
  const now = Date.now();
  for (let start = 0; start < 120; start += 100)
    await ingest(
      Array.from({ length: Math.min(100, 120 - start) }, (_, i) => ({
        log_id: `burst-${start + i}`,
        timestamp: new Date(now).toISOString(),
        service: "api",
        level: "info",
        message: `Live burst ${start + i}`,
      })),
    );
  await expect(page.locator(".log-row").first()).toContainText("Live burst", { timeout: 12000 });
  expect(await inspector.textContent()).toBe(original);
  await page.keyboard.press("Escape");
  await expect(page.locator(".log-row").first()).toBeFocused();
});

test("query following preserves rows on errors and leaves older snapshots paused", async ({
  page,
}) => {
  await page.clock.install();
  const requests: Record<string, unknown>[] = [];
  let fail = false;
  await page.route("**/api/products/*/logs/query", async (route) => {
    requests.push(route.request().postDataJSON());
    if (fail) await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    else await route.continue();
  });
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  const firstId = await page.locator(".log-row").first().getAttribute("data-log-id");
  const total = Number(
    (await page.locator(".logs-result-count").textContent())?.replace(/[^\d]/g, ""),
  );
  fail = true;
  await page.clock.runFor(5_001);
  await expect(page.getByText("The server is busy. Try again shortly.")).toBeVisible();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  await expect(page.locator(".log-row").first()).toHaveAttribute("data-log-id", firstId ?? "");
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await scrollToEnd(page);
  await expect(page.locator(".logs-footer")).toContainText(`Loaded ${Math.min(200, total)} of`);
  const pausedRequests = requests.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await page.clock.runFor(15_000);
  expect(requests).toHaveLength(pausedRequests);
  await expect(page.locator(".logs-footer")).toContainText(`Loaded ${Math.min(200, total)} of`);
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  await expect(page.locator(".logs-stream")).toHaveAttribute("aria-busy", "false");
  expect(requests.length).toBeGreaterThan(pausedRequests);
  expect(requests.slice(pausedRequests).every((request) => !request.cursor)).toBe(true);
  const visibleRequests = requests.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await page.clock.runFor(15_000);
  expect(requests).toHaveLength(visibleRequests);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await expect.poll(() => requests.length).toBeGreaterThan(visibleRequests);
  expect(requests.slice(visibleRequests).every((request) => !request.cursor)).toBe(true);
});

test("virtual logs load every older record on scroll with bounded rows and keyboard focus", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await admin("/products", {
    name: "Virtual logs fixture",
    retention_days: 30,
  });
  const { key } = await admin(`/products/${project.id}/logs/keys`, { label: "Large fixture" });
  const now = Date.now() - 5_000;
  for (let start = 0; start < 1200; start += 100) {
    const response = await fetch(`${endpoint}/api/logs/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        logs: Array.from({ length: 100 }, (_, i) => ({
          log_id: `heavy-${start + i}`,
          timestamp: new Date(now - (start + i) * 1000).toISOString(),
          level: "info",
          service: "worker",
          message: `job/${start + i} completed`,
          attributes: { cached: false, duration_ms: start + i },
        })),
      }),
    });
    expect(response.ok).toBe(true);
  }
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/products/${project.id}/logs/query`))
      requests.push(request.postDataJSON());
  });
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of 1,200");
  const initiallyMounted = await page.locator(".log-row").count();
  expect(initiallyMounted).toBeGreaterThan(1);
  expect(initiallyMounted).toBeLessThan(60);
  for (let count = 200; count <= 1200; count += 100) {
    await scrollToEnd(page);
    await expect(page.locator(".logs-footer")).toContainText(
      `Loaded ${count.toLocaleString("en-US")} of 1,200`,
    );
    expect(await page.locator(".log-row").count()).toBeLessThan(60);
  }
  await expect(page.getByRole("button", { name: "Follow", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: /older logs/i })).toHaveCount(0);
  await page.screenshot({ path: "apps/dashboard/.impeccable/screenshots/logs-buffer-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".log-row time").first()).toHaveCSS("font-size", "11px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Mobile rows re-measure after the jump and can push the footer down; scroll until it settles.
  await expect(async () => {
    await scrollToEnd(page);
    await expect(page.locator(".logs-footer")).toBeInViewport({ ratio: 1, timeout: 500 });
  }).toPass();
  await page.screenshot({ path: "apps/dashboard/.impeccable/screenshots/logs-buffer-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Every older page reads against the first page's time window, one cursor per page.
  expect(
    new Set(
      requests.filter((request) => request.cursor).map((request) => JSON.stringify(request.cursor)),
    ).size,
  ).toBe(11);
  const headRequest = requests.filter((request) => !request.cursor).at(-1);
  for (const request of requests.filter((request) => request.cursor))
    expect([request.from, request.to]).toEqual([headRequest?.from, headRequest?.to]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".log-row").first().focus();
  await page.locator(".log-row").first().press("End");
  await expect(page.locator('[data-log-id="heavy-1199"]')).toBeFocused();
  await page.locator('[data-log-id="heavy-1199"]').press("ArrowUp");
  const opener = page.locator('[data-log-id="heavy-1198"]');
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("job/1198 completed");
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: "Back to newest", exact: true }).click();
  await expect(page.locator(".log-row").first()).toHaveAttribute("data-log-id", "heavy-0");
  await expect(page.getByRole("button", { name: "Following", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("older-page failures retain rows and stale requests cannot replace a new query", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/products/*/logs/query", async (route) => {
    if (route.request().postDataJSON().cursor && fail)
      await route.fulfill({ status: 503, json: { error: "Older page busy" } });
    else await route.continue();
  });
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  const total = Number(
    (await page.locator(".logs-result-count").textContent())?.replace(/[^\d]/g, ""),
  );
  await scrollToEnd(page);
  await expect(page.getByRole("button", { name: "Retry older logs", exact: true })).toBeVisible();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  fail = false;
  await page.getByRole("button", { name: "Retry older logs", exact: true }).click();
  await expect(page.locator(".logs-footer")).toContainText(`Loaded ${Math.min(200, total)} of`);
  await page.getByRole("button", { name: "Back to newest", exact: true }).click();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/products/*/logs/query", async (route) => {
    if (route.request().postDataJSON().cursor) {
      started();
      await gate;
    }
    await route.continue().catch(() => {});
  });
  try {
    await scrollToEnd(page);
    await requested;
    await page.getByLabel("Search log messages").fill("orders/1000");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".log-row")).toHaveCount(1);
    release();
    await expect(page.locator(".logs-footer")).toContainText("Loaded 1 of 1");
    await expect(page.locator(".log-row")).toContainText("orders/1000");
  } finally {
    release();
  }
});
test("log settings create scoped keys and store independent retention", async ({ page }) => {
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".page-header").getByText("Connect a source")).toHaveCount(0);
  await page.getByRole("link", { name: "Connect a source", exact: true }).click();
  await expect(page).toHaveURL(/settings.*#logs$/);
  const settings = page.locator(".log-settings");
  // Logs is the last Settings card, so the jump can only bring most of it into view.
  await expect(settings).toBeInViewport({ ratio: 0.5 });
  await settings.getByText("Log setup guide", { exact: true }).click();
  await expect(settings.locator(".log-setup-guide")).toContainText(
    `${process.env.HIGHKEY_DASHBOARD_URL}/api/logs/ingest`,
  );
  await expect(settings.locator(".log-setup-guide")).toContainText(
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  );
  await expect(settings.locator(".log-setup-guide")).toContainText("$HIGHKEY_LOG_KEY");
  await settings.getByLabel("Log retention (days)").fill("3");
  await settings.getByRole("button", { name: "Save retention", exact: true }).click();
  await expect(settings.getByText("Log retention saved.")).toBeVisible();
  await settings.getByLabel("Key label", { exact: true }).fill("Browser checked service");
  await settings.getByRole("button", { name: "Create log key", exact: true }).click();
  await expect(settings.getByText("Save your log key", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "I’ve saved it" }).click();
  await settings.getByRole("button", { name: "Revoke log key Browser checked service" }).click();
  await page.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(settings.getByText("Log key revoked.")).toBeVisible();
  expect((await admin(`/products/${project.id}/logs/settings`)).retention_days).toBe(3);
  const projects = await admin("/products");
  expect(projects.find((item: { id: string }) => item.id === project.id).retention_days).toBe(30);
});
test("logs fit a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.locator(".log-row").first()).toBeVisible();
  await expect(page.locator(".log-row time").first()).toHaveCSS("font-size", "11px");
  expect((await page.locator(".log-row").first().boundingBox())?.height).toBeGreaterThanOrEqual(60);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "apps/dashboard/.impeccable/screenshots/logs-mobile.png" });
  await page.locator(".log-row").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "apps/dashboard/.impeccable/screenshots/logs-inspector-mobile.png",
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".log-row").first()).toBeFocused();
  await page.getByLabel("Search log messages").fill("no matching mobile records");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching logs", exact: true })).toBeVisible();
});
test("failed queries can retry and context-only empty queries show matching feedback", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/products/*/logs/query", async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { error: "Logs temporarily unavailable" } });
    else await route.continue();
  });
  await page.goto(`/projects/${project.slug}/logs`);
  await expect(page.getByText("Logs unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Couldn’t load logs" })).toBeVisible();
  await expect(page.getByText("The server is busy. Try again shortly.")).toBeVisible();
  await expect(page.getByText("Loading logs…", { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  expect(await page.locator(".log-row").count()).toBeLessThan(60);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  // Environments are chosen from received logs; a trace ID is free text and can match nothing.
  await page.getByLabel("Trace ID", { exact: true }).fill("no-such-trace");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching logs" })).toBeVisible();
  await expect(page.getByText("Connect a service in Settings.", { exact: false })).toHaveCount(0);
});

test("dragging across the log volume histogram narrows the query to those buckets", async ({
  page,
}) => {
  await page.goto(`/projects/${project.slug}/logs?logWindow=1h`);
  await expect(page.locator(".logs-footer")).toContainText("Loaded 100 of");
  const bars = await page.locator(".logs-volume-bars").boundingBox();
  if (!bars) throw new Error("Expected the volume histogram");
  const y = bars.y + bars.height / 2;
  await page.mouse.move(bars.x + bars.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(bars.x + bars.width * 0.75, y, { steps: 4 });
  await expect(page.locator(".logs-volume-brush")).toBeVisible();
  await page.mouse.move(bars.x + bars.width * 0.99, y, { steps: 4 });
  await page.mouse.up();
  await expect(page).toHaveURL(/logFrom=.*logTo=/);
  const windows = page.getByRole("group", { name: "Log time range" });
  await expect(page.getByRole("button", { name: "Clear selected range" })).toBeVisible();
  await expect(windows.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Follow", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const url = new URL(page.url());
  const from = Date.parse(url.searchParams.get("logFrom") ?? "");
  const to = Date.parse(url.searchParams.get("logTo") ?? "");
  expect(to - from).toBeGreaterThan(0);
  expect(to - from).toBeLessThanOrEqual(31 * 60_000);
  // Choosing a preset returns to a rolling window.
  await windows.getByRole("button", { name: "Last 6 hours", exact: true }).click();
  await expect(page).not.toHaveURL(/logFrom=/);
  await expect(windows.getByRole("button", { name: "Last 6 hours", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("switching sources keeps the logs stream mounted and never flashes a skeleton", async ({
  page,
}) => {
  const stamp = Date.now();
  const steady = await admin("/products", { name: `Steady logs ${stamp}`, retention_days: 30 });
  const names = [`Alpha ${stamp}`, `Beta ${stamp}`];
  for (const name of names) {
    const source = await admin(`/products/${steady.id}/sources`, { name });
    const sourceKey = (
      await admin(`/products/${steady.id}/logs/keys`, { label: name, source_id: source.id })
    ).key;
    const word = name.split(" ")[0].toLowerCase();
    const response = await fetch(`${endpoint}/api/logs/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sourceKey}` },
      body: JSON.stringify({
        logs: Array.from({ length: 20 }, (_, i) => ({
          log_id: `${word}-${stamp}-${i}`,
          timestamp: new Date(Date.now() - i * 1000 - 10000).toISOString(),
          level: "info",
          service: "api",
          message: `${word} message ${i}`,
        })),
      }),
    });
    expect(response.ok).toBe(true);
  }
  // Hold source-scoped log queries so the transition is observable.
  let release = () => {};
  let hold = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/logs/query", async (route) => {
    if (hold && route.request().postDataJSON().source_id) await gate;
    await route.continue().catch(() => {});
  });
  await page.goto(`/projects/${steady.slug}/logs`);
  await expect(page.locator(".log-row").first()).toBeVisible();
  const sources = page.getByRole("navigation", { name: "Project sources" });
  await sources.getByRole("button", { name: names[0], exact: true }).click();
  await expect(page.locator(".log-row").first()).toContainText("alpha");
  await page.getByRole("button", { name: "Following", exact: true }).click();
  await page.getByLabel("Search log messages").fill("message");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".log-row")).toHaveCount(20);
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__stream = document.querySelector(".logs-stream");
    w.__volume = document.querySelector(".logs-volume");
    w.__input = document.getElementById("log-message-search");
    w.__flashes = 0;
    new MutationObserver(() => {
      if (
        document.querySelector(
          ".logs-placeholder, .logs-empty, .logs-volume .skeleton, .logs-volume [data-slot=skeleton]",
        )
      )
        w.__flashes = (w.__flashes as number) + 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
  hold = true;
  await sources.getByRole("button", { name: names[1], exact: true }).click();
  await expect(page.locator(".logs-stream")).toHaveAttribute("aria-busy", "true");
  // The previous rows stay in place while the new source loads.
  await expect(page.locator(".log-row").first()).toContainText("alpha");
  await expect(page.getByLabel("Search log messages")).toHaveValue("message");
  release();
  await expect(page.locator(".log-row").first()).toContainText("beta");
  const state = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      stream: w.__stream === document.querySelector(".logs-stream"),
      volume: w.__volume === document.querySelector(".logs-volume"),
      input: w.__input === document.getElementById("log-message-search"),
      flashes: w.__flashes,
    };
  });
  expect(state).toEqual({ stream: true, volume: true, input: true, flashes: 0 });
});
