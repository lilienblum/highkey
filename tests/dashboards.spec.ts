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
  await expect(widget(page, "conversion").locator(".widget-growth")).toContainText("—");
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

test("New dashboard opens the agent guide with copyable commands and prompts", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/projects/${project.slug}`);
  const trigger = sidebar(page).getByRole("button", { name: "New dashboard" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New dashboard" });
  await expect(dialog).toBeVisible();
  for (const heading of ["Connect your agent", "Ask it", "Examples"])
    await expect(dialog.getByRole("heading", { name: heading })).toBeVisible();
  const status = dialog.getByRole("status");
  await dialog.getByRole("button", { name: "Copy Claude Code command" }).click();
  await expect(status).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `claude mcp add --transport http piko ${new URL(page.url()).origin}/api/mcp`,
  );
  await dialog.getByRole("button", { name: "Copy Codex config" }).click();
  const codex = await page.evaluate(() => navigator.clipboard.readText());
  expect(codex).toContain("[mcp_servers.piko]");
  expect(codex).toContain("/api/mcp");
  await expect(dialog.getByRole("link", { name: "See the docs" })).toBeVisible();
  await dialog.getByRole("button", { name: "Copy prompt" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `In Piko project "${project.slug}", create a dashboard named "…" that shows … . Use describe_project first, preview widgets with run_widget, then save_dashboard.`,
  );
  for (const example of ["Checkout error rate", "Weekly churn by cohort", "Slowest routes"])
    await expect(dialog.getByRole("button", { name: `Copy example: ${example}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Edit opens the agent guide with the dashboard slug and revision", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(dashboardUrl());
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Edit dashboard" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Copy prompt" }).click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toMatch(
    new RegExp(
      `^In Piko project "${project.slug}", update dashboard "${slug}" \\(revision (\\d+)\\): … \\. Read it with get_dashboard, preview changes with run_widget, and save with base_revision \\1\\.$`,
    ),
  );
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused();
});

test("Duplicate asks for the copy's name", async ({ page }) => {
  await page.goto(dashboardUrl());
  const menu = page.getByRole("button", { name: "Dashboard actions" });
  await menu.click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  const dialog = page.getByRole("dialog", { name: "Duplicate dashboard" });
  const field = dialog.getByLabel("Name");
  await expect(field).toHaveValue("Checkout health copy");
  await expect(field).toBeFocused();
  expect(
    await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
  ).toEqual([0, "Checkout health copy".length]);
  await field.fill("x".repeat(81));
  await dialog.getByRole("button", { name: "Duplicate" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(field).toBeFocused();
  const name = `Checkout ops ${Date.now()}`;
  await field.fill(name);
  await dialog.getByRole("button", { name: "Duplicate" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${project.slug}/dashboards/checkout-ops-\\d+(\\?|$)`),
  );
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  for (const title of titles)
    await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole("link", { name, exact: true })).toHaveAttribute(
    "data-active",
    "",
  );
  await page.getByRole("button", { name: "Dashboard actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("dialog", { name: "Duplicate dashboard" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Dashboard actions" })).toBeFocused();
});

test("an empty dashboard shows the guide inline", async ({ page }) => {
  const created = await admin<{ slug: string }>(`/products/${project.id}/dashboards`, {
    document: { version: 1, name: "Scratch", widgets: [] },
  });
  await page.goto(`/projects/${project.slug}/dashboards/${created.slug}`);
  const main = page.locator("#main-content");
  await expect(main.getByRole("heading", { name: "No widgets yet" })).toBeVisible();
  for (const heading of ["Connect your agent", "Ask it", "Examples"])
    await expect(main.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Copy prompt" })).toBeVisible();
});

test("duplicate as dashboard from Overview", async ({ page }) => {
  await page.goto(`/projects/${project.slug}`);
  await page.getByRole("button", { name: "Overview actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate as dashboard" }).click();
  const dialog = page.getByRole("dialog", { name: "Duplicate Overview" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Overview copy");
  await dialog.getByLabel("Name").fill(`Overview copy ${Date.now()}`);
  await dialog.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Overview copy \d+$/ })).toBeVisible();
  await expect(page.locator(".dashboard-widget")).toHaveCount(7);
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
  await expect(sidebar(page).locator(`a[href$="/dashboards/${created.slug}"]`)).toHaveCount(0);
  expect(
    (await admin<{ slug: string }[]>(`/read/products/${project.slug}/dashboards`)).map(
      (d) => d.slug,
    ),
  ).not.toContain(created.slug);
});

test("revisions list origins and restore an earlier version", async ({ page }) => {
  const original = `Revisions ${Date.now()}`;
  const created = await admin<{ slug: string }>(`/products/${project.id}/dashboards`, {
    document: { ...checkoutDashboard, name: original },
  });
  const saved = await fetch(`${endpoint}/api/products/${project.id}/dashboards/${created.slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-piko-admin": "1" },
    body: JSON.stringify({
      base_revision: 1,
      document: { ...checkoutDashboard, name: `${original} edited` },
    }),
  });
  expect(saved.ok, `save: ${saved.status}`).toBe(true);
  await page.goto(`/projects/${project.slug}/dashboards/${created.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: `${original} edited` })).toBeVisible();
  const menu = page.getByRole("button", { name: "Dashboard actions" });
  await menu.click();
  await page.getByRole("menuitem", { name: "Revisions" }).click();
  const sheet = page.getByRole("dialog", { name: "Revisions" });
  const rows = sheet.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Revision 2");
  await expect(rows.nth(0)).toContainText("Current");
  await expect(rows.nth(0)).toContainText("API");
  await expect(rows.nth(1)).toContainText("Revision 1");
  await expect(rows.nth(1)).toContainText(/\d{2} \w{3} \d{4}, \d{2}:\d{2}/);
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("menuitem", { name: "Revisions" }).click();
  await rows.nth(1).getByRole("button", { name: "Restore" }).click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toContainText("Restore revision 1?");
  await alert.getByRole("button", { name: "Restore revision" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Revision 3");
  await expect(rows.nth(0)).toContainText("Dashboard");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1, name: original, exact: true })).toBeVisible();
});

const sqlDashboard = {
  version: 1,
  name: "SQL views",
  widgets: [
    {
      id: "by-name",
      title: "Events by name",
      view: { type: "table" },
      size: { w: 12, h: 2 },
      queries: {
        q: {
          signal: "sql",
          database: "events",
          sql: "SELECT name AS event, count(*) AS total, epoch_ms(max(event_time)) AS last_seen, count(*) > 5 AS busy, NULL::VARCHAR AS note, json_object('kind', name) AS meta FROM events GROUP BY 1 ORDER BY 2 DESC, 1",
        },
      },
    },
    {
      id: "many",
      title: "Many rows",
      view: { type: "table" },
      size: { w: 6, h: 2 },
      queries: {
        q: {
          signal: "sql",
          database: "events",
          sql: "SELECT n AS number, 'row ' || n AS text FROM range(600) t(n)",
        },
      },
    },
    {
      id: "sql-line",
      title: "SQL events per day",
      view: { type: "line" },
      size: { w: 6, h: 2 },
      queries: {
        q: {
          signal: "sql",
          database: "events",
          sql: "SELECT epoch_ms(date_trunc($bucket, epoch_ms(event_time))) AS time, count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1",
        },
      },
      series: [{ expr: "q", label: "SQL events" }],
    },
  ],
};

test("SQL table and line widgets render with a truncation note", async ({ page }) => {
  const errors = collectErrors(page);
  const sqlSlug = (
    await admin<{ slug: string }>(`/products/${project.id}/dashboards`, { document: sqlDashboard })
  ).slug;
  await page.goto(`/projects/${project.slug}/dashboards/${sqlSlug}`);

  const events = widget(page, "by-name");
  const table = events.getByRole("region", { name: "Events by name" });
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("tabindex", "0");
  await expect(table.getByRole("columnheader")).toHaveText([
    "event",
    "total",
    "last_seen",
    "busy",
    "note",
    "meta",
  ]);
  const first = table.getByRole("row").nth(1);
  await expect(first.getByRole("cell").nth(0)).toHaveText("checkout_request");
  await expect(first.getByRole("cell").nth(1)).toHaveText("20");
  await expect(first.getByRole("cell").nth(1)).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(first.getByRole("cell").nth(2)).toContainText(/\d{4}/);
  await expect(first.getByRole("cell").nth(3)).toHaveText("true");
  await expect(first.getByRole("cell").nth(4)).toHaveText("—");
  const meta = first.getByRole("cell").nth(5);
  await expect(meta.locator(".typed-value .tok-property")).toHaveText('"kind"');
  await expect(meta.locator(".typed-value .tok-string")).toHaveText('"checkout_request"');
  await expect(table.getByRole("columnheader").first()).toHaveCSS("position", "sticky");

  const many = widget(page, "many");
  await expect(many.getByRole("region", { name: "Many rows" }).getByRole("row")).toHaveCount(501);
  await expect(many.locator(".dashboard-footer-notes")).toContainText(
    "Showing the first 500 of 600 rows",
  );

  const line = widget(page, "sql-line");
  await expect(line.locator(".analytics-plot")).toBeVisible();
  await expect(line.locator(".dashboard-legend")).toContainText("SQL events");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(widget(page, "by-name").getByRole("columnheader").first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test("a stat shows growth against the previous period without asking for it", async ({ page }) => {
  const grown = await admin<Project>("/products", {
    name: `Growth ${Date.now()}`,
    retention_days: 365,
  });
  const { key } = await admin<{ key: string }>(`/products/${grown.id}/keys`, { label: "Web" });
  const hours = (ago: number) => new Date(Date.now() - ago * 3_600_000).toISOString();
  const event = (timestamp: string) => ({
    event_id: crypto.randomUUID(),
    name: "signup",
    source: "browser",
    timestamp,
    properties: {},
  });
  // Three signups this week against two in the week before: +50%.
  await ingest("/ingest", key, {
    events: [hours(2), hours(5), hours(30), hours(24 * 9), hours(24 * 10)].map(event),
  });
  const view = (compare?: string) => ({ type: "stat", ...(compare && { compare }) });
  const queries = { signups: { signal: "events", event: "signup" } };
  const created = await admin<{ slug: string }>(`/products/${grown.id}/dashboards`, {
    document: {
      version: 1,
      name: "Growth",
      widgets: [
        { id: "signups", title: "Signups", view: view(), queries },
        { id: "quiet", title: "Signups, no comparison", view: view("none"), queries },
        { id: "trend", title: "Signup trend", view: { type: "line" }, queries },
        {
          id: "flat-trend",
          title: "Signup trend, quiet",
          view: { type: "line", compare: "none" },
          queries,
        },
        {
          id: "failures",
          title: "Failed signups",
          view: { type: "stat", better: "down" },
          queries,
        },
      ],
    },
  });
  await page.goto(`/projects/${grown.slug}/dashboards/${created.slug}?days=7`);
  await expect(widget(page, "signups").locator(".widget-value")).toHaveText("3");
  const signups = widget(page, "signups").locator(".widget-growth");
  await expect(signups).toContainText("+50% vs prior 7d");
  await expect(signups).toHaveAttribute("title", "+50% vs previous 7 days");
  await expect(signups).toHaveAttribute("data-outcome", "good");
  // The headline of a chart reads as the full sentence, and compare: none hides it.
  await expect(widget(page, "trend").locator(".widget-growth")).toHaveText(
    "+50% vs previous 7 days",
  );
  await expect(widget(page, "flat-trend").locator(".widget-growth")).toHaveCount(0);
  // A count where fewer is better is coloured as an outcome, not by its sign.
  const failures = widget(page, "failures").locator(".widget-growth");
  await expect(failures).toContainText("+50% vs prior 7d");
  await expect(failures).toHaveAttribute("data-outcome", "bad");
  await expect(failures).toHaveCSS("color", "rgb(255, 93, 98)");
  await expect(signups).toHaveCSS("color", "rgb(152, 187, 108)");
  await expect(widget(page, "quiet").locator(".widget-value")).toHaveText("3");
  await expect(widget(page, "quiet").locator(".widget-growth")).toHaveCount(0);
});
