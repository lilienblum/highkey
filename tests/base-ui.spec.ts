import { expect, test } from "@playwright/test";
import { apiHeaders } from "./auth";

const api = process.env.HIGHKEY_API_URL;
let alpha: { id: string; name: string };
let zulu: { id: string; name: string; slug: string };

test.beforeAll(async () => {
  const create = async (name: string) => {
    const response = await fetch(`${api}/api/products`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ name, retention_days: 30 }),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  alpha = await create(`Alpha keyboard ${Date.now()}`);
  zulu = await create(`Zulu keyboard ${Date.now()}`);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("highkey:product", id), alpha.id);
});

test("project select supports typeahead, keyboard selection, Escape and human-readable labels", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const overview = page.getByRole("link", { name: "Overview", exact: true });
  await expect(overview).toHaveAttribute("aria-current", "page");
  await expect(overview).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const select = page.getByRole("combobox", { name: "Select project", exact: true });
  await expect(select).toContainText(alpha.name);
  await select.press("ArrowDown");
  await page.keyboard.type("Zulu");
  await expect(page.getByRole("option", { name: zulu.name, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(select).toContainText(zulu.name);
  await expect(select).toBeFocused();
  await expect(page.getByRole("heading", { name: zulu.name, exact: true })).toBeVisible();
  await select.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(select).toBeFocused();
  await expect(select).toContainText(zulu.name);
  // The dashboard sets no cookie of its own; the session's is the only one.
  expect(
    (await context.cookies()).filter(
      (cookie) => !cookie.name.endsWith("better-auth.session_token"),
    ),
  ).toEqual([]);
  await expect(page.getByRole("link", { name: "Events", exact: true })).toHaveAttribute(
    "href",
    `/owner/${zulu.slug}/events?source=all&days=7`,
  );
});

test("nested source icon picker closes before its dialog and restores keyboard focus", async ({
  page,
}) => {
  await page.goto("/settings");
  const opener = page.getByRole("button", { name: "Add source", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Add a source", exact: true });
  await dialog.getByLabel("Source name").fill("iOS client");
  const icon = dialog.getByRole("button", { name: /^Source icon:/ });
  await expect(icon).toHaveAccessibleName("Source icon: Automatic · iOS");
  await icon.press("Enter");
  const picker = page.getByRole("dialog", { name: "Source icon", exact: true });
  await picker.getByRole("button", { name: "Website", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(icon).toHaveAccessibleName("Source icon: Website");
  await icon.press("Enter");
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(icon).toBeFocused();
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(icon).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Source name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

for (const width of [1440, 894, 390]) {
  test(`selects keep the page scrollbar and layout stable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings");
    await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(alpha.name);
    const geometry = () =>
      page.evaluate(() => {
        const main = document.querySelector("main")?.getBoundingClientRect();
        if (!main) throw new Error("Expected the dashboard layout to be mounted");
        return {
          gutter: innerWidth - document.documentElement.clientWidth,
          bodyWidth: document.body.getBoundingClientRect().width,
          mainX: main.x,
          mainWidth: main.width,
          scrollY,
        };
      });
    const before = await geometry();
    for (const name of ["Select project", "Event timezone"]) {
      const select = page.getByRole("combobox", { name, exact: true });
      await select.click();
      await expect(page.getByRole("listbox")).toBeVisible();
      expect(await geometry()).toEqual(before);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toBeHidden();
      await expect(select).toBeFocused();
      expect(await geometry()).toEqual(before);
    }
    // A filter picker must not lock page scrolling or remove its scrollbar.
    await page.getByRole("combobox", { name: "Select project", exact: true }).click();
    await page.mouse.move(width / 2, 700);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before.scrollY);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
  });
}
