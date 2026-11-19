// Organizations in the address: /<organization>/<project>/…, the switcher, and old links.
import { expect, request, test } from "@playwright/test";
import { totpCode } from "../apps/dashboard/test/totp";
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
    name: string;
  };
  const second = (await (
    await api.post("/api/auth/organization/create", {
      data: { name: `Side ${id}`, slug: `side-${id}` },
    })
  ).json()) as { id: string; slug: string; name: string };
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

/** A new account signed in through its own request context. */
async function signUp(email: string) {
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const signed = await api.post("/api/auth/sign-up/email", {
    data: { name: email.split("@")[0], email, password: "a long enough password" },
  });
  expect(signed.ok()).toBe(true);
  return api;
}

async function invite(
  api: Awaited<ReturnType<typeof signUp>>,
  organizationId: string,
  email: string,
) {
  const invited = await api.post("/api/auth/organization/invite-member", {
    data: { email, role: "member", organizationId },
  });
  expect(invited.ok()).toBe(true);
  return (await invited.json()) as { id: string };
}

// Every page offers a way on: losing the open organization, having none, or owing two-factor
// codes never ends at an error page.
test.describe("no dead ends", () => {
  test("deleting the open organization opens another one", async ({ browser }) => {
    const { api, second, sideProject } = await personWithTwoOrganizations();
    const spare = (await (
      await api.post("/api/auth/organization/create", {
        data: { name: `Spare ${run}`, slug: `spare-${run}` },
      })
    ).json()) as { id: string };
    await api.post("/api/auth/organization/set-active", { data: { organizationId: spare.id } });
    expect(
      (
        await api.post("/api/auth/organization/delete", { data: { organizationId: spare.id } })
      ).ok(),
    ).toBe(true);
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    await page.goto("/");
    // The first organization (by name) opens.
    await expect(page).toHaveURL(new RegExp(`/${second.slug}/${sideProject.slug}`));
    await expect(page.locator(".workspace-project")).toContainText(sideProject.name);
    await context.close();
  });

  test("someone in no organization can join one or create their own", async ({ browser }) => {
    const { api: inviter, second } = await personWithTwoOrganizations();
    const email = `newcomer-${run}@example.com`;
    const invitation = await invite(inviter, second.id, email);
    // Invited people get no organization of their own when they sign up.
    const api = await signUp(email);
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(`${base}/welcome`);
    await expect(page.getByRole("heading", { name: "No organization yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: `Join ${second.name}` })).toHaveAttribute(
      "href",
      `/join/${invitation.id}`,
    );
    await expect(page.getByRole("button", { name: "Create organization" })).toBeEnabled();
    await page.getByLabel("Organization name").fill(`Newcomer ${run}`);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(new RegExp(`/newcomer-${run}`));
    await expect(page.locator(".organization-trigger")).toContainText(`Newcomer ${run}`);
    await context.close();
  });

  test("a member who must turn on two-factor codes is taken to Account", async ({ browser }) => {
    const { api: owner, home } = await personWithTwoOrganizations();
    const enabled = await owner.post("/api/auth/two-factor/enable", {
      data: { password: "a long enough password" },
    });
    expect(enabled.ok()).toBe(true);
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    expect(
      (
        await owner.post("/api/auth/two-factor/verify-totp", { data: { code: totpCode(totpURI) } })
      ).ok(),
    ).toBe(true);
    const email = `codes-later-${run}@example.com`;
    const invitation = await invite(owner, home.id, email);
    const member = await signUp(email);
    expect(
      (
        await member.post("/api/auth/organization/accept-invitation", {
          data: { invitationId: invitation.id },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await owner.post("/api/auth/organization/update", {
          data: { organizationId: home.id, data: { requireTwoFactor: true } },
        })
      ).ok(),
    ).toBe(true);
    const context = await browser.newContext({ storageState: await member.storageState() });
    const page = await context.newPage();
    await page.goto(`/${home.slug}`);
    await expect(page).toHaveURL(`${base}/settings/account`);
    await expect(page.getByText(`${home.name} requires two-factor codes`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up two-factor codes" })).toBeVisible();
    await context.close();
  });
});
