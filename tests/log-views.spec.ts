import { expect, test, type Page } from "@playwright/test";
import { apiHeaders } from "./auth";

const endpoint = process.env.HIGHKEY_API_URL;
if (!endpoint) throw new Error("Run dashboard browser tests through bun test:e2e.");

type Project = { id: string; slug: string; name: string; sources?: { id: string }[] };
type View = {
  id: string;
  slug: string;
  kind: string;
  document: Record<string, unknown> & { query: Record<string, unknown> };
};
async function admin<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${endpoint}/api${path}`, {
    method,
    headers: apiHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const run = Date.now();
const errorsName = `Checkout errors ${run}`;
let project: Project;
let errorsView: View;
const logsUrl = () => `/projects/${project.slug}/logs`;
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const logViews = (page: Page) => sidebar(page).getByRole("list", { name: "Log views" });
const viewParam = (page: Page) => new URL(page.url()).searchParams.get("view");
const stored = (slug: string) =>
  admin<View>(`/read/products/${project.slug}/views/${slug}?kind=logs`);
const severity = (page: Page) => page.getByRole("combobox", { name: "Severity", exact: true });
const service = (page: Page) => page.getByRole("combobox", { name: "Service", exact: true });
const windowButton = (page: Page, label: string) =>
  page.getByRole("group", { name: "Log time range" }).getByRole("button", { name: label });

test.beforeAll(async () => {
  project = await admin<Project>("/products", { name: `Log views ${run}`, retention_days: 30 });
  const key = (await admin<{ key: string }>(`/products/${project.id}/logs/keys`, { label: "Svc" }))
    .key;
  const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const log = (
    id: string,
    seconds: number,
    level: string,
    svc: string,
    status: number,
    message: string,
  ) => ({
    log_id: `${id}-${run}`,
    timestamp: at(seconds),
    level,
    service: svc,
    environment: "production",
    message,
    attributes: { status, region: "tokyo" },
  });
  const response = await fetch(`${endpoint}/api/logs/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      logs: [
        log("a", 60, "error", "checkout", 500, "checkout failed"),
        log("b", 120, "warn", "checkout", 200, "checkout slow"),
        log("c", 180, "info", "checkout", 200, "checkout ok"),
        log("d", 90, "error", "api", 500, "api failed"),
        log("e", 3 * 3600, "error", "checkout", 500, "checkout failed earlier"),
      ],
    }),
  });
  expect(response.ok).toBe(true);
  errorsView = await admin<View>(`/products/${project.id}/views`, {
    document: {
      version: 1,
      kind: "logs",
      name: errorsName,
      query: {
        min_level: "warn",
        service: "checkout",
        filters: [{ attribute: "status", value: 500 }],
      },
      window: "6h",
    },
  });
  // An event view with the same name must stay out of the Logs list.
  await admin(`/products/${project.id}/views`, {
    document: { version: 1, kind: "events", name: errorsName, query: { measure: "count" } },
  });
});

test("the sidebar lists log views under Logs from the server render", async ({ page }) => {
  const runtime = page.waitForResponse((response) => response.url().endsWith("/_highkey/runtime"));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await gate;
    await route.fallback();
  });
  try {
    await page.goto(logsUrl(), { waitUntil: "commit" });
    await expect(logViews(page).getByRole("link", { name: errorsName, exact: true })).toBeVisible();
    await expect(logViews(page).getByRole("link")).toHaveCount(1);
    await expect(logViews(page).getByRole("button", { name: "New view" })).toBeVisible();
    release();
    await runtime;
  } finally {
    release();
  }
});

test("opening a log view applies its filters and window and marks it active", async ({ page }) => {
  await page.goto(logsUrl());
  const link = logViews(page).getByRole("link", { name: errorsName, exact: true });
  await expect(link).not.toHaveAttribute("data-active", "");
  await link.click();
  await expect.poll(() => viewParam(page)).toBe(errorsView.slug);
  await expect(link).toHaveAttribute("data-active", "");
  await expect(severity(page)).toContainText("Warn and above");
  await expect(service(page)).toContainText("checkout");
  await expect(windowButton(page, "Last 6 hours")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Filters · Applied" })).toBeVisible();
  await expect(page.getByText("2 records", { exact: true })).toBeVisible();
  // The first attribute filter has its row in the filter panel, which opens with the view.
  await expect(page.getByRole("combobox", { name: "Attribute", exact: true })).toContainText(
    "status",
  );
  await expect(page.getByLabel("Value", { exact: true })).toHaveValue("500");
  // A direct link and a reload keep it.
  await page.goto(`${logsUrl()}?view=${errorsView.slug}`);
  await expect(page.getByText("2 records", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("2 records", { exact: true })).toBeVisible();
  await expect(link).toHaveAttribute("data-active", "");
});

test("a log view that no longer exists says so and offers a way back", async ({ page }) => {
  await page.goto(`${logsUrl()}?view=gone-${run}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "This view no longer exists" }),
  ).toBeVisible();
  await page.locator("#main-content").getByRole("link", { name: "Clear selection" }).click();
  await expect.poll(() => viewParam(page)).toBeNull();
  await expect(page.getByRole("heading", { level: 1, name: "Logs", exact: true })).toBeVisible();
});

test("Save view stores the current filters and window and opens it", async ({ page }) => {
  const name = `Api errors ${run}`;
  await page.goto(logsUrl());
  await severity(page).click();
  await page.getByRole("option", { name: "Error", exact: true }).click();
  await service(page).click();
  await page.getByRole("option", { name: "api", exact: true }).click();
  await windowButton(page, "Last 24 hours").click();
  await expect(page.getByText("1 record", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(dialog).toBeHidden();
  const list = await admin<{ slug: string; name: string }[]>(
    `/read/products/${project.slug}/views?kind=logs`,
  );
  const saved = list.find((view) => view.name === name);
  expect(saved).toBeTruthy();
  expect((await stored(saved?.slug ?? "")).document).toMatchObject({
    kind: "logs",
    query: { level: "error", service: "api" },
    window: "24h",
  });
  await expect.poll(() => viewParam(page)).toBe(saved?.slug);
  await expect(logViews(page).getByRole("link", { name, exact: true })).toHaveAttribute(
    "data-active",
    "",
  );
  // Views sort by name with New view last.
  const items = await logViews(page).locator("> li").allInnerTexts();
  expect(items.at(-1)).toBe("New view");
  expect(items.slice(0, -1)).toEqual([...items.slice(0, -1)].sort((a, b) => a.localeCompare(b)));
});

test("a log view can be updated, renamed, copied and deleted from its menu", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: {
      version: 1,
      kind: "logs",
      name: `Menu logs ${run}`,
      description: "kept across updates",
      query: { level: "error" },
      window: "15m",
    },
  });
  const link = (name: string) => logViews(page).getByRole("link", { name, exact: true });
  await page.goto(`${logsUrl()}?view=${created.slug}`);
  await expect(severity(page)).toContainText("Error");

  // Update with the current filters.
  await service(page).click();
  await page.getByRole("option", { name: "checkout", exact: true }).click();
  await windowButton(page, "Last 6 hours").click();
  await expect(page.getByText("2 records", { exact: true })).toBeVisible();
  const row = await page.locator(".log-row").first().elementHandle();
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current filters" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Updated" })).toBeVisible();
  // Updating moves only the applied version, so the stream stays as it is.
  await expect.poll(() => new URL(page.url()).searchParams.get("viewAt")).not.toBeNull();
  expect(await row?.evaluate((element) => element.isConnected)).toBe(true);
  expect((await stored(created.slug)).document).toMatchObject({
    description: "kept across updates",
    query: { level: "error", service: "checkout" },
    window: "6h",
  });

  // Rename keeps the slug and the filters.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename view" });
  await dialog.getByLabel("Name").fill(`Renamed logs ${run}`);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(link(`Renamed logs ${run}`)).toHaveAttribute("data-active", "");
  expect((await stored(created.slug)).document).toMatchObject({
    name: `Renamed logs ${run}`,
    query: { service: "checkout" },
  });
  expect(viewParam(page)).toBe(created.slug);

  // Copy JSON hands over the stored document.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Copy JSON" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({
    kind: "logs",
    window: "6h",
  });

  // The agent guide names the log kind.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Edit with your agent" }).click();
  await expect(page.getByRole("dialog", { name: "Edit view" })).toContainText("kind logs");
  await page.keyboard.press("Escape");

  // Delete asks first, then drops the view from the sidebar.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete view" }).click();
  await expect(link(`Renamed logs ${run}`)).toHaveCount(0);
  await expect.poll(() => viewParam(page)).toBeNull();
  const response = await fetch(
    `${endpoint}/api/read/products/${project.slug}/views/${created.slug}?kind=logs`,
  );
  expect(response.status).toBe(404);
});

test("an agent-written log view opens with every field shown and Update keeps them", async ({
  page,
}) => {
  const projects = await admin<Project[]>("/products");
  const source = projects.find((candidate) => candidate.id === project.id)?.sources?.[0]?.id ?? "";
  expect(source).not.toBe("");
  const query = {
    min_level: "error",
    service: "checkout",
    environment: "production",
    source_id: source,
    search: "checkout",
    filters: [
      { attribute: "status", value: 500 },
      { attribute: "region", value: "tokyo" },
    ],
  };
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "logs", name: `Agent logs ${run}`, query, window: "24h" },
  });
  await page.goto(`${logsUrl()}?view=${created.slug}`);
  await expect(severity(page)).toContainText("Error and above");
  await expect(page.getByLabel("Search log messages")).toHaveValue("checkout");
  await expect(windowButton(page, "Last 24 hours")).toHaveAttribute("aria-pressed", "true");
  const also = page.getByRole("region", { name: "Also applied" });
  await expect(also).toContainText("Source ·");
  await expect(also).toContainText('region = "tokyo"');
  await expect(page.getByText("2 records", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Environment" })).toContainText("production");

  // Updating without edits keeps every field.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current filters" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Updated" })).toBeVisible();
  expect((await stored(created.slug)).document).toMatchObject({ query, window: "24h" });

  // Removing a chip and updating drops only that field.
  await also.getByRole("button", { name: 'Remove filter region = "tokyo"' }).click();
  // Focus moves to the chip before it, then to the Filters control once none remain.
  await expect(also.getByRole("button", { name: "Remove source" })).toBeFocused();
  await also.getByRole("button", { name: "Remove source" }).click();
  await expect(page.locator("#log-filters-toggle")).toBeFocused();
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current filters" }).click();
  const { source_id: _source, ...withoutSource } = query;
  await expect
    .poll(async () => (await stored(created.slug)).document.query)
    .toEqual({ ...withoutSource, filters: [{ attribute: "status", value: 500 }] });
});

test("a log view the page cannot run says so and offers the agent guide", async ({ page }) => {
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "logs", name: `Odd logs ${run}`, query: { level: "error" } },
  });
  await page.route(`**/api/read/products/*/views/${created.slug}?kind=logs`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.query.level = "loud";
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${logsUrl()}?view=${created.slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "This view uses settings Logs can’t show" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit with your agent" }).click();
  await expect(page.getByRole("dialog", { name: "Edit view" })).toContainText(created.slug);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Clear view" }).click();
  await expect.poll(() => viewParam(page)).toBeNull();
  await expect(page.getByRole("heading", { level: 1, name: "Logs", exact: true })).toBeVisible();
});

test("a hand-made link with a window still applies the view", async ({ page }) => {
  await page.goto(`${logsUrl()}?view=${errorsView.slug}&logWindow=15m`);
  await expect(severity(page)).toContainText("Warn and above");
  await expect(windowButton(page, "Last 6 hours")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2 records", { exact: true })).toBeVisible();
});

test("without channels, an agent's change to the open log view applies by polling", async ({
  page,
}) => {
  const name = `Polled logs ${run}`;
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "logs", name, query: { level: "error" }, window: "6h" },
  });
  await page.route("**/_highkey/runtime", (route) => route.fulfill({ json: { live: false } }));
  await page.clock.install();
  const hydrated = page.waitForResponse("**/_highkey/runtime");
  await page.goto(`${logsUrl()}?view=${created.slug}`);
  await hydrated;
  await expect(severity(page)).toContainText("Error");
  await admin(
    `/products/${project.id}/views/${created.slug}`,
    {
      document: {
        version: 1,
        kind: "logs",
        name,
        query: { level: "error", service: "checkout" },
        window: "6h",
      },
    },
    "PUT",
  );
  await page.clock.runFor(31_000);
  await expect(service(page)).toContainText("checkout");
  await expect(page.getByText("Changed by your agent")).toHaveCount(0);
});

const replaceView = (slug: string, document: unknown) =>
  admin<View>(`/products/${project.id}/views/${slug}`, { document }, "PUT");

test("an agent's change waits while a trace ID narrows the page", async ({ page }) => {
  const name = `Trace narrowed ${run}`;
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "logs", name, query: { level: "error" }, window: "6h" },
  });
  await page.goto(`${logsUrl()}?view=${created.slug}`);
  await expect(severity(page)).toContainText("Error");
  await expect.poll(() => new URL(page.url()).searchParams.get("viewAt")).not.toBeNull();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Trace ID", { exact: true }).fill("a".repeat(32));
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("trace")).toBe("a".repeat(32));
  await replaceView(created.slug, {
    version: 1,
    kind: "logs",
    name,
    query: { level: "error", service: "checkout" },
    window: "6h",
  });
  await expect(page.getByText("Changed by your agent")).toBeVisible();
  // The page keeps the narrowing until the reader loads the latest version.
  expect(new URL(page.url()).searchParams.get("trace")).toBe("a".repeat(32));
  await expect(service(page)).not.toContainText("checkout");
});

test("an agent's change waits while a range selected on the histogram narrows the page", async ({
  page,
}) => {
  const name = `Range narrowed ${run}`;
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "logs", name, query: { level: "error" }, window: "6h" },
  });
  await page.goto(`${logsUrl()}?view=${created.slug}`);
  await expect(severity(page)).toContainText("Error");
  await expect.poll(() => new URL(page.url()).searchParams.get("viewAt")).not.toBeNull();
  const bars = await page.locator(".logs-volume-bars").boundingBox();
  if (!bars) throw new Error("Expected the volume histogram");
  const y = bars.y + bars.height / 2;
  await page.mouse.move(bars.x + bars.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(bars.x + bars.width * 0.75, y, { steps: 4 });
  await page.mouse.move(bars.x + bars.width * 0.99, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Clear selected range" })).toBeVisible();
  await replaceView(created.slug, {
    version: 1,
    kind: "logs",
    name,
    query: { level: "error", service: "checkout" },
    window: "6h",
  });
  await expect(page.getByText("Changed by your agent")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear selected range" })).toBeVisible();
  await expect(service(page)).not.toContainText("checkout");
});

test("Save view says a trace ID filter is not part of a view", async ({ page }) => {
  await page.goto(`${logsUrl()}?trace=${"a".repeat(32)}`);
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await expect(dialog).toContainText("The trace ID filter isn’t saved.");
  await page.keyboard.press("Escape");
  await page.goto(logsUrl());
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText("isn’t saved");
});
