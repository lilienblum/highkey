import { expect, test, type Page } from "@playwright/test";

const endpoint = process.env.PIKO_API_URL;
if (!endpoint) throw new Error("Run dashboard browser tests through bun test:e2e.");

type Project = { id: string; slug: string; name: string };
type Widget = { id: string; title: string; size?: { w: number; h: number } };
type Stored = {
  id: string;
  slug: string;
  revision: number;
  document: { name: string; widgets: Widget[] };
};
type Revision = { revision: number; origin: string; created_at: string };

/** Management and read calls as a script would make them: no `x-piko-origin`, so origin "api". */
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${endpoint}/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-piko-admin": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return response.json();
}

const layout = (name: string) => ({
  version: 1,
  name,
  widgets: [
    {
      id: "alpha",
      title: "Alpha notes",
      size: { w: 4, h: 1 },
      view: { type: "text", markdown: "First note." },
    },
    {
      id: "events",
      title: "Event count",
      size: { w: 4, h: 1 },
      view: { type: "stat" },
      queries: { events: { signal: "events" } },
    },
    {
      id: "gamma",
      title: "Gamma notes",
      size: { w: 4, h: 1 },
      view: { type: "text", markdown: "Third note." },
    },
  ],
});

let project: Project;
test.beforeAll(async () => {
  project = await call<Project>("/products", "POST", {
    name: `Editing ${Date.now()}`,
    retention_days: 30,
  });
});

let created = 0;
async function createDashboard(title: string) {
  const document = layout(`${title} ${Date.now()}-${++created}`);
  const stored = await call<Stored>(`/products/${project.id}/dashboards`, "POST", { document });
  return { stored, document, url: `/projects/${project.slug}/dashboards/${stored.slug}` };
}
const readDashboard = (id: string) =>
  call<Stored>(`/read/products/${project.slug}/dashboards/${id}`);

const widget = (page: Page, id: string) => page.locator(`.dashboard-widget[data-widget="${id}"]`);
const order = (page: Page) =>
  page
    .locator(".dashboard-widget")
    .evaluateAll((all) => all.map((e) => e.getAttribute("data-widget")));
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const announcer = (page: Page) => page.locator("[data-dashboard-announcer]");

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // A 409 is an expected answer here; the browser still logs the failed request.
    if (message.type() === "error" && !/409|503/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function startEditing(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator(".page-content")).toHaveAttribute("aria-busy", "false");
  await button(page, "Edit").click();
  await expect(page.getByRole("region", { name: "Edit dashboard" })).toBeVisible();
}

test("edit, reorder by keyboard, resize and save persists after reload", async ({ page }) => {
  const errors = collectErrors(page);
  const { stored, url } = await createDashboard("Layout");
  await startEditing(page, url);
  await expect(button(page, "Save")).toBeDisabled();

  const later = widget(page, "alpha").getByRole("button", { name: "Move later" });
  await later.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);
  // Focus stays on the control that moved, and the new position is announced politely.
  await expect(later).toBeFocused();
  await expect(announcer(page)).toHaveAttribute("aria-live", "polite");
  await expect(announcer(page)).toHaveText("Alpha notes moved to position 2 of 3");
  await page.keyboard.press("Enter");
  await expect.poll(() => order(page)).toEqual(["events", "gamma", "alpha"]);
  await expect(announcer(page)).toHaveText("Alpha notes moved to position 3 of 3");
  // At the end Move later stays focusable but does nothing.
  await expect(later).toBeFocused();
  await expect(later).toHaveAttribute("aria-disabled", "true");
  await widget(page, "alpha").getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  const size = widget(page, "alpha").getByRole("combobox", { name: "Size" });
  await expect(size).toHaveText(/4×1/);
  await size.click();
  await page.getByRole("option", { name: "Wide", exact: true }).click();
  await expect(widget(page, "alpha")).toHaveAttribute("data-w", "12");
  await expect(size).toHaveText(/Wide/);

  await button(page, "Save").click();
  await expect(button(page, "Edit")).toBeFocused();
  await expect(page.getByRole("region", { name: "Edit dashboard" })).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);

  const saved = await readDashboard(stored.id);
  expect(saved.revision).toBe(2);
  expect(saved.document.widgets.map((w) => w.id)).toEqual(["events", "alpha", "gamma"]);
  expect(saved.document.widgets[1].size).toEqual({ w: 12, h: 2 });
  const revisions = await call<Revision[]>(
    `/read/products/${project.slug}/dashboards/${stored.id}/revisions`,
  );
  expect(revisions[0]).toMatchObject({ revision: 2, origin: "dashboard" });

  await page.reload();
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);
  await expect(widget(page, "alpha")).toHaveAttribute("data-w", "12");
  await expect(widget(page, "alpha")).toHaveAttribute("data-h", "2");
  expect(errors).toEqual([]);
});

test("drag a widget by its handle to reorder it", async ({ page }) => {
  const { url } = await createDashboard("Drag");
  await startEditing(page, url);
  const target = widget(page, "gamma");
  const box = await target.boundingBox();
  if (!box) throw new Error("gamma is not laid out");
  await widget(page, "alpha").locator("[data-drag-handle]").hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 6 });
  await expect(page.locator(".dashboard-drop-indicator")).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(["events", "gamma", "alpha"]);
  await expect(page.locator(".dashboard-drop-indicator")).toHaveCount(0);
  await expect(announcer(page)).toHaveText("Alpha notes moved to position 3 of 3");
});

test("cancel discards and leaving with changes asks first", async ({ page }) => {
  const { stored, url } = await createDashboard("Cancel");
  await startEditing(page, url);
  await widget(page, "alpha").getByRole("button", { name: "Move later" }).click();
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);
  await button(page, "Cancel").click();
  await expect.poll(() => order(page)).toEqual(["alpha", "events", "gamma"]);
  await expect(button(page, "Edit")).toBeFocused();

  await button(page, "Edit").click();
  const overview = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Overview", exact: true });
  await widget(page, "gamma").getByRole("button", { name: "Move earlier" }).click();
  await expect.poll(() => order(page)).toEqual(["alpha", "gamma", "events"]);
  // A date range change stays on the dashboard, so it keeps the draft without asking.
  await page.getByRole("button", { name: "Choose date range", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Last 30 days", exact: true }).click();
  await expect(page).toHaveURL(/days=30/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(["alpha", "gamma", "events"]);

  await overview.click();
  const dialog = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/dashboards/${stored.slug}`));
  await expect.poll(() => order(page)).toEqual(["alpha", "gamma", "events"]);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await overview.click();
  await page
    .getByRole("alertdialog", { name: "Discard unsaved changes?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}(\\?|$)`));
  await expect(page.locator(".overview-dashboard")).toBeVisible();
  const kept = await readDashboard(stored.id);
  expect(kept.revision).toBe(1);
  expect(kept.document.widgets.map((w) => w.id)).toEqual(["alpha", "events", "gamma"]);

  // Leaving without changes does not ask.
  await startEditing(page, url);
  await overview.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}(\\?|$)`));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("an API write during editing shows the conflict banner", async ({ page }) => {
  const errors = collectErrors(page);
  const { stored, document, url } = await createDashboard("Conflict");
  const connected = page.waitForResponse(
    (response) => response.url().includes("/_tako/channels/") && response.ok(),
  );
  await startEditing(page, url);
  await connected;
  await widget(page, "alpha").getByRole("button", { name: "Move later" }).click();
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);

  const theirs = structuredClone(document);
  theirs.widgets[2].title = "Gamma from the API";
  const written = await call<Stored>(`/products/${project.id}/dashboards/${stored.id}`, "PUT", {
    base_revision: 1,
    document: theirs,
  });
  expect(written.revision).toBe(2);

  // The live hint brings revision 2 while the draft is dirty.
  const banner = page.getByRole("alert").filter({ hasText: "Changed by API" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("just now");
  await expect(button(page, "Save")).toBeDisabled();
  await expect.poll(() => order(page)).toEqual(["events", "alpha", "gamma"]);
  await banner.getByRole("button", { name: "Keep mine" }).click();
  await expect(banner).toBeHidden();
  await expect(button(page, "Edit")).toBeVisible();

  const saved = await readDashboard(stored.id);
  expect(saved.revision).toBe(3);
  expect(saved.document.widgets.map((w) => w.id)).toEqual(["events", "alpha", "gamma"]);
  expect(saved.document.widgets[2].title).toBe("Gamma notes");
  const revisions = await call<Revision[]>(
    `/read/products/${project.slug}/dashboards/${stored.id}/revisions`,
  );
  expect(revisions.map((r) => [r.revision, r.origin])).toEqual([
    [3, "dashboard"],
    [2, "api"],
    [1, "api"],
  ]);
  expect(errors).toEqual([]);
});

test("a stale save shows the conflict banner and can load their version", async ({ page }) => {
  // Without live hints the editor learns of the other write from the save's 409.
  await page.route("**/_tako/channels/**", (route) => route.abort());
  const { stored, document, url } = await createDashboard("Stale");
  await startEditing(page, url);
  await widget(page, "alpha").getByRole("button", { name: "Move later" }).click();
  const theirs = structuredClone(document);
  theirs.widgets[2].title = "Gamma from the API";
  await call(`/products/${project.id}/dashboards/${stored.id}`, "PUT", {
    base_revision: 1,
    document: theirs,
  });

  await button(page, "Save").click();
  const banner = page.getByRole("alert").filter({ hasText: "Changed by API" });
  await expect(banner).toBeVisible();
  await expect(page.getByRole("region", { name: "Edit dashboard" })).toBeVisible();
  await banner.getByRole("button", { name: "Load their version" }).click();
  await expect(banner).toBeHidden();
  await expect.poll(() => order(page)).toEqual(["alpha", "events", "gamma"]);
  await expect(widget(page, "gamma").getByRole("heading", { level: 2 })).toHaveText(
    "Gamma from the API",
  );
  await expect(button(page, "Save")).toBeDisabled();

  // Editing their version saves on top of it.
  await widget(page, "gamma").getByRole("button", { name: "Move earlier" }).click();
  await button(page, "Save").click();
  await expect(button(page, "Edit")).toBeVisible();
  const saved = await readDashboard(stored.id);
  expect(saved.revision).toBe(3);
  expect(saved.document.widgets.map((w) => [w.id, w.title])).toEqual([
    ["alpha", "Alpha notes"],
    ["gamma", "Gamma from the API"],
    ["events", "Event count"],
  ]);
});

test("remove widget asks inline", async ({ page }) => {
  const { stored, url } = await createDashboard("Remove");
  await startEditing(page, url);
  const events = widget(page, "events");
  await events.getByRole("button", { name: "Remove" }).click();
  const confirm = events.getByRole("group", { name: "Remove Event count?" });
  await expect(confirm).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(confirm.getByRole("button", { name: "Keep" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(events.getByRole("button", { name: "Remove" })).toBeFocused();

  await events.getByRole("button", { name: "Remove" }).click();
  await events.getByRole("button", { name: "Remove widget" }).click();
  await expect(events).toHaveCount(0);
  await expect(announcer(page)).toHaveText("Removed Event count");
  await expect(widget(page, "gamma").getByRole("button", { name: "Move earlier" })).toBeFocused();

  // Duplicate places a copy right after its source.
  await widget(page, "alpha").getByRole("button", { name: "Duplicate" }).click();
  await expect.poll(() => order(page)).toEqual(["alpha", "alpha-2", "gamma"]);
  await expect(widget(page, "alpha-2").getByRole("heading", { level: 2 })).toHaveText(
    "Alpha notes (copy)",
  );

  await button(page, "Save").click();
  await expect(button(page, "Edit")).toBeVisible();
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["alpha", "alpha-2", "gamma"]);
  const saved = await readDashboard(stored.id);
  expect(saved.document.widgets.map((w) => w.id)).toEqual(["alpha", "alpha-2", "gamma"]);
});
