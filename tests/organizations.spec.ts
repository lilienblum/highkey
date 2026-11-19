// Organizations in the address: /<organization>/<project>/…, the switcher, and old links.
import { expect, request, test } from "@playwright/test";
import { apiHeaders } from "./auth";

const base = process.env.HIGHKEY_DASHBOARD_URL as string;
const run = Date.now();

/** Someone with two organizations of their own, each holding one project. */
let people = 0;

async function personWithTwoOrganizations() {
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const id = `${run}-${++people}`;
  const email = `switcher-${id}@example.com`;
  expect(
    (
      await api.post("/api/auth/sign-up/email", {
        data: { name: `Switcher ${id}`, email, password: "a long enough password" },
      })
    ).ok(),
  ).toBe(true);
  const session = (await (await api.get("/api/auth/get-session")).json()) as {
    session: { activeOrganizationId: string };
  };
  const first = (await (await api.get("/api/auth/organization/list")).json()) as {
    id: string;
    slug: string;
  }[];
  const home = first.find((org) => org.id === session.session.activeOrganizationId) as {
    id: string;
    slug: string;
  };
  const second = (await (
    await api.post("/api/auth/organization/create", {
      data: { name: `Side ${id}`, slug: `side-${id}` },
    })
  ).json()) as { id: string; slug: string };
  const projectIn = async (org: { id: string }, name: string) => {
    await api.post("/api/auth/organization/set-active", { data: { organizationId: org.id } });
    const created = await api.post("/api/products", { data: { name, retention_days: 30 } });
    expect(created.ok()).toBe(true);
    return (await created.json()) as { id: string; slug: string; name: string };
  };
  const homeProject = await projectIn(home, `Home site ${id}`);
  const sideProject = await projectIn(second, `Side app ${id}`);
  await api.post("/api/auth/organization/set-active", { data: { organizationId: home.id } });
  return { api, home, second, homeProject, sideProject };
}

test.describe("organizations", () => {
  test("switching organizations shows only that organization's projects", async ({ browser }) => {
    const { api, home, second, homeProject, sideProject } = await personWithTwoOrganizations();
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    await page.goto(`/${home.slug}`);
    await expect(page).toHaveURL(new RegExp(`/${home.slug}/${homeProject.slug}`));
    await expect(page.locator(".workspace-project")).toContainText(homeProject.name);
    await page.locator(".organization-trigger").click();
    await page.getByRole("menuitem", { name: new RegExp(`Side ${run}-1`) }).click();
    await expect(page).toHaveURL(new RegExp(`/${second.slug}/${sideProject.slug}`));
    await expect(page.locator(".workspace-project")).toContainText(sideProject.name);
    await expect(page.locator(".organization-trigger")).toContainText(`Side ${run}-1`);
    // The other organization's project is not offered here.
    await page.locator(".workspace-project").getByRole("combobox").click();
    await expect(page.getByRole("option", { name: homeProject.name })).toHaveCount(0);
    await context.close();
  });

  test("an old project URL redirects", async ({ page }) => {
    const created = await (
      await fetch(`${base}/api/products`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ name: `Legacy link ${run}`, retention_days: 30 }),
      })
    ).json();
    await page.goto(`/projects/${created.slug}/events?days=30`);
    await expect(page).toHaveURL(`${base}/owner/${created.slug}/events?days=30`);
    await page.goto("/projects/no-such-project");
    await expect(
      page.getByRole("heading", { name: "This selection is unavailable" }),
    ).toBeVisible();
  });

  test("a project URL of another organization is not found", async ({ page }) => {
    const { home, homeProject } = await personWithTwoOrganizations();
    // Not a member there: the same answer as a project that does not exist.
    await page.goto(`/${home.slug}/${homeProject.slug}`);
    await expect(
      page.getByRole("heading", { name: "This selection is unavailable" }),
    ).toBeVisible();
    await expect(page.getByText(homeProject.name)).toHaveCount(0);
  });
});
