import { expect, test, type Page } from "@playwright/test";

const endpoint = process.env.PIKO_API_URL;
if (!endpoint) throw new Error("Run dashboard browser tests through bun test:e2e.");

type Project = { id: string; slug: string; name: string };
type View = {
  id: string;
  slug: string;
  kind: string;
  document: { name: string; kind: string; query: { event?: string } };
};
async function admin<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${endpoint}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-piko-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const run = Date.now();
const planName = `Pro plan signups ${run}`;
let project: Project;
let planView: View;
const eventsUrl = () => `/projects/${project.slug}/events`;
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const eventViews = (page: Page) => sidebar(page).getByRole("list", { name: "Event views" });
const viewParam = (page: Page) => new URL(page.url()).searchParams.get("view");
const views = () =>
  admin<{ slug: string; name: string }[]>(`/read/products/${project.slug}/views?kind=events`);

test.beforeAll(async () => {
  project = await admin<Project>("/products", { name: `Views ${run}`, retention_days: 30 });
  const key = (await admin<{ key: string }>(`/products/${project.id}/keys`, { label: "Web" })).key;
  const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  const response = await fetch(`${endpoint}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      events: [
        ...["pro", "pro", "free"].map((plan, i) => ({
          event_id: crypto.randomUUID(),
          name: "signup",
          source: "browser",
          timestamp: at(60 + i),
          properties: { plan },
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          event_id: crypto.randomUUID(),
          name: "page_view",
          source: "browser",
          timestamp: at(30 + i),
          properties: {},
        })),
      ],
    }),
  });
  expect(response.ok).toBe(true);
  planView = await admin<View>(`/products/${project.id}/views`, {
    document: {
      version: 1,
      kind: "events",
      name: planName,
      query: {
        event: "signup",
        measure: "count",
        group_by: "property:plan",
        filters: [{ property: "plan", op: "eq", value: "pro" }],
      },
    },
  });
});

test("the old Explore paths redirect to Events and keep their search", async ({ page }) => {
  const query = encodeURIComponent(
    JSON.stringify({
      event: "signup",
      source: "",
      measure: "count",
      property: "duration_ms",
      group: "name",
      filterProperty: "",
      filterOp: "eq",
      filterValue: "",
    }),
  );
  await page.goto(`/projects/${project.slug}/explore?source=all&days=30&query=${query}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/events\\?`));
  const params = new URL(page.url()).searchParams;
  expect(params.get("days")).toBe("30");
  expect(params.get("source")).toBe("all");
  expect(JSON.parse(params.get("query") ?? "null")).toMatchObject({ event: "signup" });
  await expect(page.getByRole("heading", { level: 1, name: "Events", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Event", exact: true })).toContainText("signup");

  await page.goto(`/explore?days=30&page=1`);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/events");
  expect(new URL(page.url()).searchParams.get("days")).toBe("30");
  await expect(page.getByRole("heading", { level: 1, name: "Events", exact: true })).toBeVisible();
});

test("the sidebar says Events and lists saved views from the server render", async ({ page }) => {
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
    await page.goto(eventsUrl(), { waitUntil: "commit" });
    await expect(sidebar(page).getByRole("link", { name: "Events", exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Explore" })).toHaveCount(0);
    const link = sidebar(page).getByRole("link", { name: planName, exact: true });
    await expect(link).toBeVisible();
    await expect(
      eventViews(page).getByRole("button", { name: "New view", exact: true }),
    ).toBeVisible();
    release();
    await runtime;
  } finally {
    release();
  }
});

test("opening a saved view applies its query and marks it active", async ({ page }) => {
  await page.goto(eventsUrl());
  const link = sidebar(page).getByRole("link", { name: planName, exact: true });
  await expect(link).not.toHaveAttribute("data-active", "");
  await link.click();
  await expect.poll(() => viewParam(page)).toBe(planView.slug);
  await expect(link).toHaveAttribute("data-active", "");
  await expect(page.getByRole("combobox", { name: "Event", exact: true })).toContainText("signup");
  await expect(page.getByRole("button", { name: "Filter · 1" })).toBeVisible();
  await expect(page.getByText("across 2 matching events")).toBeVisible();
  const applied = JSON.parse(new URL(page.url()).searchParams.get("query") ?? "null");
  expect(applied).toMatchObject({
    event: "signup",
    group: "property:plan",
    filterProperty: "plan",
    filterValue: "pro",
  });
  // A direct link opens it too, and a reload keeps it.
  await page.goto(`${eventsUrl()}?view=${planView.slug}`);
  await expect(page.getByText("across 2 matching events")).toBeVisible();
  await page.reload();
  await expect(page.getByText("across 2 matching events")).toBeVisible();
  await expect(link).toHaveAttribute("data-active", "");
});

test("a view that no longer exists says so and offers a way back", async ({ page }) => {
  await page.goto(`${eventsUrl()}?view=gone-${run}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "This view no longer exists" }),
  ).toBeVisible();
  await page.locator("#main-content").getByRole("link", { name: "Clear selection" }).click();
  await expect.poll(() => viewParam(page)).toBeNull();
  await expect(page.getByRole("heading", { level: 1, name: "Events", exact: true })).toBeVisible();
});

test("New view opens the agent guide where you are, without navigating", async ({ page }) => {
  await page.goto(`/projects/${project.slug}/logs`);
  const path = new URL(page.url()).pathname;
  await eventViews(page).getByRole("button", { name: "New view", exact: true }).click();
  const guide = page.getByRole("dialog", { name: "New event view" });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('save_view with kind "events"');
  for (const heading of ["Connect your agent", "Ask it", "Examples"])
    await expect(guide.getByRole("heading", { name: heading })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(path);
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(path);
});

test("Save view stores the current query and opens it", async ({ page }) => {
  const name = `Page views ${run}`;
  await page.goto(eventsUrl());
  await page.getByRole("combobox", { name: "Event", exact: true }).click();
  await page.getByRole("option", { name: "page_view", exact: true }).click();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByText("across 4 matching events")).toBeVisible();
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = (await views()).find((view) => view.name === name);
  expect(saved).toBeTruthy();
  const stored = await admin<View>(
    `/read/products/${project.slug}/views/${saved?.slug}?kind=events`,
  );
  expect(stored.document).toMatchObject({
    kind: "events",
    query: { event: "page_view", measure: "count" },
  });
  expect(stored.document.query).not.toHaveProperty("group_by");
  await expect.poll(() => viewParam(page)).toBe(saved?.slug);
  await expect(sidebar(page).getByRole("link", { name, exact: true })).toHaveAttribute(
    "data-active",
    "",
  );
  // The new view sorts by name among the others, with New view still last.
  const items = await eventViews(page).locator("> li").allInnerTexts();
  expect(items.at(-1)).toBe("New view");
  // With a view open, the header offers its actions instead of Save view.
  await expect(page.getByRole("button", { name: "Save view", exact: true })).toHaveCount(0);
  expect(items.slice(0, -1)).toEqual([...items.slice(0, -1)].sort((a, b) => a.localeCompare(b)));
});

test("a view can be updated, renamed, copied and deleted from its menu", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: {
      version: 1,
      kind: "events",
      name: `Menu view ${run}`,
      query: { event: "page_view", measure: "count", group_by: "name" },
    },
  });
  const link = (name: string) => sidebar(page).getByRole("link", { name, exact: true });
  await page.goto(`${eventsUrl()}?view=${created.slug}`);
  await expect(page.getByText("across 4 matching events")).toBeVisible();

  // Update with the current query.
  await page.getByRole("combobox", { name: "Event", exact: true }).click();
  await page.getByRole("option", { name: "signup", exact: true }).click();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByText("across 3 matching events")).toBeVisible();
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current query" }).click();
  await expect
    .poll(
      async () =>
        (await admin<View>(`/read/products/${project.slug}/views/${created.slug}?kind=events`))
          .document.query.event,
    )
    .toBe("signup");

  // Rename keeps the slug and the query.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename view" });
  await dialog.getByLabel("Name").fill(`Renamed view ${run}`);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(link(`Renamed view ${run}`)).toHaveAttribute("data-active", "");
  const renamed = await admin<View>(
    `/read/products/${project.slug}/views/${created.slug}?kind=events`,
  );
  expect(renamed.document).toMatchObject({
    name: `Renamed view ${run}`,
    query: { event: "signup" },
  });
  expect(viewParam(page)).toBe(created.slug);

  // Copy JSON hands over the stored document.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Copy JSON" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({
    name: `Renamed view ${run}`,
    kind: "events",
  });

  // Edit with your agent opens the guide with a view prompt.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Edit with your agent" }).click();
  const guide = page.getByRole("dialog", { name: "Edit view" });
  await expect(guide).toContainText("get_view");
  await expect(guide).toContainText("save_view");
  await expect(guide).toContainText(created.slug);
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();

  // Delete asks first.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(`Renamed view ${run}`);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect((await views()).some((view) => view.slug === created.slug)).toBe(true);
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete view" }).click();
  await expect.poll(() => viewParam(page)).toBeNull();
  await expect(link(`Renamed view ${run}`)).toHaveCount(0);
  expect((await views()).some((view) => view.slug === created.slug)).toBe(false);
});

test("the collapsed rail reaches views from Events by keyboard", async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem("piko:product", id);
    localStorage.setItem("piko:sidebar", "collapsed");
  }, project.id);
  await page.goto(eventsUrl());
  const events = sidebar(page).getByRole("button", { name: "Events", exact: true });
  await events.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("dialog", { name: "Events" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Events", exact: true })).toBeFocused();
  await expect(menu.getByRole("button", { name: "New view" })).toBeVisible();
  // Tab walks the views in name order.
  const names = await menu.getByRole("list", { name: "Views" }).getByRole("link").allInnerTexts();
  await page.keyboard.press("Tab", { delay: 0 });
  for (let step = 0; step < names.indexOf(planName); step++) await page.keyboard.press("Tab");
  await expect(menu.getByRole("link", { name: planName, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => viewParam(page)).toBe(planView.slug);
  await expect(menu).toBeHidden();
});

const agentQuery = (sourceId: string) => ({
  event: "signup",
  source_id: sourceId,
  identity_kind: "anonymous",
  measure: "max",
  property: "seats",
  group_by: "property:plan",
  filters: [
    { property: "plan", op: "eq", value: "pro" },
    { property: "region", op: "ne", value: "eu" },
    { property: "seats", op: "gte", value: 2 },
  ],
});
async function sourceId() {
  const projects = await admin<(Project & { sources: { id: string }[] })[]>("/products");
  const found = projects.find((candidate) => candidate.id === project.id);
  return found?.sources[0]?.id ?? "";
}
const stored = (slug: string) =>
  admin<View>(`/read/products/${project.slug}/views/${slug}?kind=events`);

test("an agent-written view opens with every field shown and Update keeps them", async ({
  page,
}) => {
  const source = await sourceId();
  expect(source).not.toBe("");
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "events", name: `Agent view ${run}`, query: agentQuery(source) },
  });
  await page.goto(`${eventsUrl()}?view=${created.slug}`);
  await expect(page.getByRole("combobox", { name: "Measure", exact: true })).toContainText(
    "Numeric maximum",
  );
  await expect(page.getByRole("button", { name: "Filter · 3" })).toBeVisible();
  const pins = page.getByRole("region", { name: "Also applied" });
  await expect(pins).toContainText("Identity kind · anonymous");
  await expect(pins).toContainText('region ≠ "eu"');
  await expect(pins).toContainText("seats ≥ 2");
  await expect(pins).toContainText("Source ·");
  await expect(page.getByRole("heading", { name: /can’t show/ })).toHaveCount(0);

  // Updating without edits keeps every field.
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current query" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Updated" })).toBeVisible();
  expect((await stored(created.slug)).document.query).toEqual(agentQuery(source));

  // Removing a chip and updating drops only that field.
  await pins.getByRole("button", { name: 'Remove filter region ≠ "eu"' }).click();
  await pins.getByRole("button", { name: "Remove identity kind" }).click();
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current query" }).click();
  const expected = agentQuery(source);
  expected.filters.splice(1, 1);
  const { identity_kind: _dropped, ...withoutIdentity } = expected;
  await expect
    .poll(async () => (await stored(created.slug)).document.query)
    .toEqual(withoutIdentity);
});

test("a view the page cannot show says so and offers the agent guide", async ({ page }) => {
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: {
      version: 1,
      kind: "events",
      name: `Odd view ${run}`,
      query: { measure: "count" },
    },
  });
  await page.route(`**/api/read/products/*/views/${created.slug}?kind=events`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.query.group_by = "bogus";
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${eventsUrl()}?view=${created.slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "This view uses settings Events can’t show" }),
  ).toBeVisible();
  await expect(page.getByText("invalid project, date range, or filter")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit with your agent" }).click();
  await expect(page.getByRole("dialog", { name: "Edit view" })).toContainText(created.slug);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Clear view" }).click();
  await expect.poll(() => viewParam(page)).toBeNull();
  await expect(page.getByRole("heading", { level: 1, name: "Events", exact: true })).toBeVisible();
});

test("a rejected save shows the API's message and hint and creates nothing", async ({ page }) => {
  const name = `Limited ${run}`;
  await page.route("**/api/products/*/views", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 429,
      headers: { "retry-after": "12" },
      json: {
        error: "Too many dashboard writes; slow down",
        code: "rate_limited",
        errors: [
          {
            path: "",
            message: "Too many dashboard writes for this project",
            hint: "Retry after 12 s",
          },
        ],
      },
    });
  });
  await page.goto(eventsUrl());
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(dialog).toContainText(
    "Too many dashboard writes for this project. Retry after 12 s",
  );
  await expect(dialog).toBeVisible();
  expect((await views()).some((view) => view.name === name)).toBe(false);
});

const replaceView = (slug: string, document: unknown) =>
  admin<View>(`/products/${project.id}/views/${slug}`, { document }, "PUT");

test("an agent's change to the open view applies in place when nothing changed here", async ({
  page,
}) => {
  const name = `Agent edits ${run}`;
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "events", name, query: { event: "signup", measure: "count" } },
  });
  await page.goto(`${eventsUrl()}?view=${created.slug}`);
  await expect(page.getByText("across 3 matching events")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("viewAt")).not.toBeNull();
  const builder = await page.locator(".query-builder").elementHandle();
  await replaceView(created.slug, {
    version: 1,
    kind: "events",
    name,
    query: { event: "page_view", measure: "count" },
  });
  await expect(page.getByText("across 4 matching events")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Event", exact: true })).toContainText(
    "page_view",
  );
  await expect(page.getByText("Changed by your agent")).toHaveCount(0);
  // In place: the page did not reopen the view.
  expect(await builder?.evaluate((element) => element.isConnected)).toBe(true);
});

test("an agent's change waits while you have your own, and Update refuses to revert it", async ({
  page,
}) => {
  const name = `Contested ${run}`;
  const created = await admin<View>(`/products/${project.id}/views`, {
    document: { version: 1, kind: "events", name, query: { event: "signup", measure: "count" } },
  });
  await page.goto(`${eventsUrl()}?view=${created.slug}`);
  await expect(page.getByText("across 3 matching events")).toBeVisible();
  await page.getByRole("combobox", { name: "Event", exact: true }).click();
  await page.getByRole("option", { name: "page_view", exact: true }).click();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(page.getByText("across 4 matching events")).toBeVisible();
  const agents = {
    event: "signup",
    measure: "count",
    filters: [{ property: "plan", op: "eq", value: "pro" }],
  };
  await replaceView(created.slug, { version: 1, kind: "events", name, query: agents });
  await expect(page.getByText("Changed by your agent")).toBeVisible();
  await expect(page.getByText("across 4 matching events")).toBeVisible();

  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current query" }).click();
  await expect(page.getByRole("alert")).toContainText("changed after you opened it");
  expect((await stored(created.slug)).document.query).toEqual(agents);

  await page.getByRole("button", { name: "Load latest" }).click();
  await expect(page.getByText("across 2 matching events")).toBeVisible();
  await expect(page.getByText("Changed by your agent")).toHaveCount(0);
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Update view with current query" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Updated" })).toBeVisible();
  expect((await stored(created.slug)).document.query).toEqual(agents);
});
