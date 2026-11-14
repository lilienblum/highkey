import { expect, test, type Page } from "@playwright/test";

const endpoint = process.env.PIKO_API_URL;
if (!endpoint) throw new Error("Run dashboard browser tests through bun test:e2e.");

type Project = { id: string; slug: string; name: string };
async function admin<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${endpoint}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-piko-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return response.json();
}
async function ingest(path: string, key: string, body: unknown) {
  const response = await fetch(`${endpoint}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
}

const checkoutDashboard = {
  version: 1,
  name: "Checkout health",
  description: "Errors and conversion around checkout",
  widgets: [
    {
      id: "conversion",
      title: "Checkout conversion",
      description: "Completed checkouts per checkout request",
      view: {
        type: "stat",
        unit: "percent",
        decimals: 1,
        sparkline: true,
        compare: "previous_period",
      },
      queries: {
        completed: { signal: "events", event: "checkout_completed" },
        requests: { signal: "events", event: "checkout_request" },
      },
      series: [
        {
          expr: "completed / requests * 100",
          label: "Conversion",
          thresholds: [
            { at: 0, color: "red" },
            { at: 10, color: "green" },
          ],
        },
      ],
    },
    {
      id: "error-rate",
      title: "Checkout error rate",
      view: { type: "line", unit: "percent", decimals: 1, compare: "previous_period" },
      size: { w: 6, h: 2 },
      queries: {
        errors: { signal: "logs", min_level: "error", service: "checkout" },
        requests: { signal: "events", event: "checkout_request" },
      },
      series: [
        {
          expr: "errors / requests * 100",
          label: "Error rate",
          color: "red",
          thresholds: [{ at: 5, color: "yellow" }],
        },
      ],
    },
    {
      id: "plans",
      title: "Checkouts by plan",
      view: { type: "ranking" },
      queries: {
        completed: { signal: "events", event: "checkout_completed", group_by: "property:plan" },
      },
    },
    {
      id: "recent-errors",
      title: "Recent checkout errors",
      view: { type: "logs" },
      queries: { errors: { signal: "logs", min_level: "error", service: "checkout" } },
    },
    {
      id: "note",
      title: "Reading this dashboard",
      view: { type: "text", markdown: "Conversion is **completed / requests**." },
    },
  ],
};
const titles = checkoutDashboard.widgets.map((widget) => widget.title);

let project: Project;
let slug: string;
const dashboardUrl = () => `/projects/${project.slug}/dashboards/${slug}`;
const widget = (page: Page, id: string) => page.locator(`.dashboard-widget[data-widget="${id}"]`);

test.beforeAll(async () => {
  project = await admin<Project>("/products", {
    name: `Dashboards ${Date.now()}`,
    retention_days: 30,
  });
  const events = (await admin<{ key: string }>(`/products/${project.id}/keys`, { label: "Web" }))
    .key;
  const logs = (
    await admin<{ key: string }>(`/products/${project.id}/logs/keys`, { label: "Checkout" })
  ).key;
  const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  await ingest("/ingest", events, {
    events: [
      ...Array.from({ length: 20 }, (_, i) => ({
        event_id: crypto.randomUUID(),
        name: "checkout_request",
        source: "browser",
        timestamp: at(120 + i),
        properties: {},
      })),
      ...["pro", "pro", "free"].map((plan, i) => ({
        event_id: crypto.randomUUID(),
        name: "checkout_completed",
        source: "browser",
        timestamp: at(90 + i),
        properties: { plan },
      })),
    ],
  });
  await ingest("/logs/ingest", logs, {
    logs: [
      ...["Card declined by issuer", "Payment gateway timed out"].map((message, i) => ({
        log_id: `error-${i}`,
        timestamp: at(60 + i),
        level: "error",
        service: "checkout",
        environment: "production",
        message,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        log_id: `info-${i}`,
        timestamp: at(30 + i),
        level: "info",
        service: "checkout",
        environment: "production",
        message: `Checkout ${i} completed`,
      })),
    ],
  });
  slug = (
    await admin<{ slug: string }>(`/products/${project.id}/dashboards`, {
      document: checkoutDashboard,
    })
  ).slug;
});

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Handled query backpressure still produces a browser network diagnostic.
    if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)"))
      errors.push(message.text());
  });
  return errors;
}

test("dashboards appear under Overview in the server-rendered sidebar and render", async ({
  page,
}) => {
  const errors = collectErrors(page);
  const runtime = page.waitForResponse((response) => response.url().endsWith("/_piko/runtime"));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await gate;
    await route.fallback();
  });
  try {
    await page.goto(dashboardUrl(), { waitUntil: "commit" });
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    const link = navigation.getByRole("link", { name: "Checkout health", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("data-active", "");
    await expect(page.getByRole("heading", { level: 1, name: "Checkout health" })).toBeVisible();
    await expect(page.getByText("Errors and conversion around checkout")).toBeVisible();
    await expect(page.locator(".dashboard-widget")).toHaveCount(checkoutDashboard.widgets.length);
    release();
    await runtime;
    for (const title of titles)
      await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
    await expect(widget(page, "conversion").locator(".widget-value")).toHaveText("15.0%");
    await expect(widget(page, "conversion").locator(".dashboard-stat")).toHaveAttribute(
      "data-color",
      "green",
    );
    await expect(widget(page, "error-rate").locator(".dashboard-legend")).toContainText(
      "Error rate",
    );
    await expect(widget(page, "error-rate").locator(".analytics-plot")).toBeVisible();
    await expect(widget(page, "plans")).toContainText("pro");
    await expect(widget(page, "plans")).toContainText("free");
    // An unlabelled series reads as what it measures, not as its query id.
    await expect(widget(page, "plans").locator(".breakdown-head")).toHaveText("planEvents");
    await expect(widget(page, "recent-errors")).toContainText("Payment gateway timed out");
    await expect(widget(page, "recent-errors")).not.toContainText("Checkout 0 completed");
    await expect(
      widget(page, "recent-errors").getByRole("link", { name: "Open in Logs" }),
    ).toHaveAttribute("href", /\/logs\?.*service=checkout/);
    await expect(widget(page, "note").locator("strong")).toHaveText("completed / requests");
    await expect(page.locator(".page-content")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("dashboard-desktop.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test("collapsed rail reaches dashboards from Overview by keyboard", async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem("piko:product", id);
    localStorage.setItem("piko:sidebar", "collapsed");
  }, project.id);
  await page.goto(`/projects/${project.slug}`);
  const overview = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Overview", exact: true });
  await overview.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("dialog", { name: "Overview" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const link = menu.getByRole("link", { name: "Checkout health", exact: true });
  await expect(link).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("collapsed-menu.png") });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/dashboards/${slug}`));
  await expect(page.getByRole("heading", { level: 1, name: "Checkout health" })).toBeVisible();
  await expect(menu).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(overview).toBeVisible();
});

test("widgets lay out in one column on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(dashboardUrl());
  const widgets = page.locator(".dashboard-widget");
  await expect(widgets).toHaveCount(checkoutDashboard.widgets.length);
  await expect(widget(page, "conversion").locator(".widget-value")).toHaveText("15.0%");
  const boxes = await widgets.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.x), width: Math.round(box.width) };
    }),
  );
  expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
  expect(new Set(boxes.map((box) => box.width)).size).toBe(1);
  expect(boxes[0].width).toBeGreaterThan(300);
  await page.screenshot({ path: test.info().outputPath("dashboard-phone.png"), fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test("a 90-day range clamps logs widgets and says so", async ({ page }) => {
  await page.goto(dashboardUrl());
  await expect(widget(page, "recent-errors")).toContainText("Payment gateway timed out");
  await expect(widget(page, "recent-errors").locator(".widget-footer")).not.toContainText("Newest");
  await page.getByRole("button", { name: "Choose date range", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Last 90 days", exact: true }).click();
  await expect(widget(page, "recent-errors").locator(".widget-footer")).toContainText(
    "Newest 31 days",
  );
  await expect(widget(page, "error-rate").locator(".widget-footer")).toContainText(
    "Newest 31 days",
  );
  await expect(widget(page, "conversion").locator(".widget-footer")).not.toContainText("Newest");
  await expect(widget(page, "recent-errors").locator(".widget-footer")).toContainText(
    "Logs kept 7 days",
  );
});

test("a missing dashboard shows a way back", async ({ page }) => {
  await page.goto(`/projects/${project.slug}/dashboards/nope`);
  await expect(
    page.getByRole("heading", { level: 1, name: "This dashboard no longer exists" }),
  ).toBeVisible();
  const back = page.locator("#main-content").getByRole("link", { name: "Go to Overview" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}(\\?|$)`));
  await expect(page.locator(".overview-dashboard")).toBeVisible();
});

test("empty project renders dashes, not errors", async ({ page }) => {
  const empty = await admin<Project>("/products", {
    name: `Empty dashboards ${Date.now()}`,
    retention_days: 30,
  });
  const created = await admin<{ slug: string }>(`/products/${empty.id}/dashboards`, {
    document: checkoutDashboard,
  });
  await page.goto(`/projects/${empty.slug}/dashboards/${created.slug}`);
  await expect(widget(page, "conversion").locator(".widget-value")).toHaveText("—");
  await expect(widget(page, "conversion")).toContainText("— vs previous period");
  await expect(widget(page, "error-rate")).toContainText("No values in this range");
  await expect(widget(page, "plans")).toContainText("No values in this range");
  await expect(widget(page, "recent-errors")).toContainText("No matching logs in this range");
  await expect(page.locator(".page-content")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a timed-out widget waits for Retry while live refreshes re-run the others", async ({
  page,
}) => {
  let conversionRuns = 0;
  let planRuns = 0;
  await page.route("**/api/read/products/*/widgets/run", async (route) => {
    const id = route.request().postDataJSON().widget.id;
    if (id === "plans") planRuns++;
    if (id === "conversion" && conversionRuns++ === 0) {
      await route.fulfill({
        status: 503,
        json: { error: "Timed out after 5 s", code: "query_timeout" },
      });
      return;
    }
    await route.fallback();
  });
  await page.clock.install();
  const connected = page.waitForResponse(
    (response) => response.url().includes("/_tako/channels/") && response.ok(),
  );
  await page.goto(dashboardUrl());
  await connected;
  const footer = widget(page, "conversion").locator(".widget-footer");
  await expect(footer.getByRole("alert")).toContainText("Timed out after 5 s");
  await expect(widget(page, "plans")).toContainText("pro");
  // The connection's reconcile waits for the dashboard's 30 s cadence instead of re-running at once.
  await page.waitForTimeout(2500);
  expect(planRuns).toBe(1);
  expect(conversionRuns).toBe(1);
  await page.clock.runFor(31_000);
  await expect.poll(() => planRuns).toBe(2);
  await expect(widget(page, "plans")).toContainText("pro");
  await page.waitForTimeout(1000);
  expect(conversionRuns).toBe(1);
  await expect(footer.getByRole("alert")).toContainText("Timed out after 5 s");
  await footer.getByRole("button", { name: "Retry" }).click();
  await expect(widget(page, "conversion").locator(".widget-value")).toHaveText("15.0%");
  await expect(footer.getByRole("alert")).toHaveCount(0);
  expect(conversionRuns).toBe(2);
});

test("widget runs wait for the viewport and run at most three at a time", async ({ page }) => {
  const stats = Array.from({ length: 7 }, (_, i) => ({
    ...checkoutDashboard.widgets[0],
    id: `stat-${i}`,
    title: `Conversion ${i}`,
  }));
  const spacer = (i: number) => ({
    id: `spacer-${i}`,
    title: `Notes ${i}`,
    size: { w: 12, h: 3 },
    view: { type: "text", markdown: "Spacing between widgets." },
  });
  const far = { ...checkoutDashboard.widgets[0], id: "far", title: "Far conversion" };
  const created = await admin<{ slug: string }>(`/products/${project.id}/dashboards`, {
    document: {
      version: 1,
      name: "Load order",
      widgets: [...stats, spacer(1), spacer(2), spacer(3), far],
    },
  });
  let inFlight = 0;
  let peak = 0;
  const requested: string[] = [];
  await page.route("**/api/read/products/*/widgets/run", async (route) => {
    requested.push(route.request().postDataJSON().widget.id);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const response = await route.fetch();
    inFlight--;
    await route.fulfill({ response });
  });
  await page.goto(`/projects/${project.slug}/dashboards/${created.slug}`);
  for (const stat of stats)
    await expect(widget(page, stat.id).locator(".widget-value")).toHaveText("15.0%");
  expect(peak).toBeLessThanOrEqual(3);
  expect(peak).toBeGreaterThanOrEqual(2);
  expect(requested).not.toContain("far");
  await widget(page, "far").scrollIntoViewIfNeeded();
  await expect(widget(page, "far").locator(".widget-value")).toHaveText("15.0%");
  expect(requested).toContain("far");
});

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

test("new dashboard from Overview creates an editable copy and opens it", async ({ page }) => {
  await page.goto(`/projects/${project.slug}`);
  const trigger = sidebar(page).getByRole("button", { name: "New dashboard" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New dashboard" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill("Ops");
  await dialog.getByRole("button", { name: "Start from Overview" }).click();
  await dialog.getByRole("button", { name: "Create dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/dashboards/ops(\\?|$)`));
  await expect(page.getByRole("heading", { level: 1, name: "Ops" })).toBeVisible();
  await expect(page.locator(".dashboard-widget")).toHaveCount(7);
  for (const heading of await page.locator(".dashboard-widget h2").all())
    await expect(heading).toBeVisible();
  await expect(sidebar(page).getByRole("link", { name: "Ops", exact: true })).toHaveAttribute(
    "data-active",
    "",
  );
});

test("a blank dashboard is created empty and a rejected name shows inline", async ({ page }) => {
  await page.goto(`/projects/${project.slug}`);
  await sidebar(page).getByRole("button", { name: "New dashboard" }).click();
  const dialog = page.getByRole("dialog", { name: "New dashboard" });
  await dialog.getByLabel("Name").fill("x".repeat(81));
  await dialog.getByRole("button", { name: "Create dashboard" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill("Scratch");
  await dialog.getByRole("button", { name: "Create dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Scratch" })).toBeVisible();
  await expect(page.getByText("No widgets yet")).toBeVisible();
});

test("duplicate as dashboard from Overview", async ({ page }) => {
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Overview actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate as dashboard" }).click();
  const dialog = page.getByRole("dialog", { name: "New dashboard" });
  await expect(dialog.getByRole("button", { name: "Start from Overview" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByLabel("Name").fill("Overview copy");
  await dialog.getByRole("button", { name: "Create dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview copy" })).toBeVisible();
  await expect(page.locator(".dashboard-widget")).toHaveCount(7);
});

test("duplicating a dashboard opens its copy", async ({ page }) => {
  await page.goto(dashboardUrl());
  await page.getByRole("button", { name: "Dashboard actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout health copy" })).toBeVisible();
  await expect(page.locator(".dashboard-widget")).toHaveCount(checkoutDashboard.widgets.length);
  await expect(
    sidebar(page).getByRole("link", { name: "Checkout health copy", exact: true }),
  ).toBeVisible();
});

test("copy JSON puts a valid document on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(dashboardUrl());
  await page.getByRole("button", { name: "Dashboard actions" }).click();
  await page.getByRole("menuitem", { name: "Copy JSON" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(text);
  expect(parsed.version).toBe(1);
  expect(parsed.name).toBe("Checkout health");
  expect(parsed.widgets).toHaveLength(checkoutDashboard.widgets.length);
  expect(text).toContain('\n  "version": 1');
});

test("delete asks first and returns to Overview", async ({ page }) => {
  const created = await admin<{ slug: string }>(`/products/${project.id}/dashboards`, {
    document: checkoutDashboard,
  });
  await page.goto(`/projects/${project.slug}/dashboards/${created.slug}`);
  const menu = page.getByRole("button", { name: "Dashboard actions" });
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toContainText("Delete Checkout health? Its revisions are deleted too.");
  await alert.getByRole("button", { name: "Cancel" }).click();
  await expect(alert).toBeHidden();
  await expect(menu).toBeFocused();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout health" })).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}(\\?|$)`));
  await expect(page.locator(".overview-dashboard")).toBeVisible();
  await expect(
    sidebar(page).getByRole("link", { name: "Checkout health", exact: true }),
  ).toHaveCount(1);
  expect(
    (await admin<{ slug: string }[]>(`/read/products/${project.slug}/dashboards`)).map(
      (d) => d.slug,
    ),
  ).not.toContain(created.slug);
});
