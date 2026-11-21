// Organizations in the address: /<organization>/<project>/…, the switcher, and old links.
import { expect, request, test } from "@playwright/test";
import { totpCode } from "../apps/app/test/totp";
import { apiHeaders, createTestOrganization } from "./auth";

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
  const home = await createTestOrganization(api, `Switcher ${id}`);
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
  test("selected projects limit a member and a project token lists just its project", async ({
    browser,
  }) => {
    const { api: owner, home, homeProject } = await personWithTwoOrganizations();
    const email = `selected-${run}@example.com`;
    const invitation = await invite(owner, home.id, email),
      member = await signUp(email);
    expect(
      (
        await member.post("/api/auth/organization/accept-invitation", {
          data: { invitationId: invitation.id },
        })
      ).ok(),
    ).toBe(true);
    const second = (await (
      await owner.post("/api/products", { data: { name: `Hidden ${run}`, retention_days: 30 } })
    ).json()) as { id: string };
    const c = await browser.newContext({ storageState: await owner.storageState() });
    const page = await c.newPage();
    await page.goto("/settings/members");
    await page.getByRole("button", { name: `Projects for ${email}` }).click();
    const d = page.getByRole("dialog");
    await d.getByRole("combobox", { name: "Project access mode" }).click();
    await page.getByRole("option", { name: "Selected projects only" }).click();
    await d.getByRole("combobox", { name: `Access to ${homeProject.name}` }).click();
    await page.getByRole("option", { name: "Read only", exact: true }).click();
    await d.getByRole("button", { name: "Save project access" }).click();
    await expect(d).toBeHidden();
    const list = await (await member.get("/api/products")).json();
    expect(list.map((p: { id: string }) => p.id)).toEqual([homeProject.id]);
    expect((await member.get(`/api/products/${second.id}/sources`)).status()).toBe(404);
    const memberPage = await browser.newPage({ storageState: await member.storageState() });
    await memberPage.goto(`/${home.slug}/${homeProject.slug}`);
    await memberPage.getByRole("combobox", { name: "Select project" }).click();
    await expect(memberPage.getByRole("option", { name: homeProject.name })).toBeVisible();
    await expect(memberPage.getByRole("option", { name: "New project", exact: true })).toHaveCount(
      0,
    );
    await memberPage.close();
    await page.goto("/settings/keys");
    await page.getByRole("button", { name: "New API key" }).click();
    await d.getByRole("textbox", { name: "Name", exact: true }).fill("One project");
    await d.getByRole("combobox", { name: "Project scope" }).click();
    await page.getByRole("option", { name: homeProject.name, exact: true }).click();
    await d.getByRole("button", { name: "Create key" }).click();
    const key = await d.locator(".settings-secret code").innerText();
    const res = await fetch(`${base}/api/read/products`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect((await res.json()).map((p: { id: string }) => p.id)).toEqual([homeProject.id]);
    await c.close();
  });
  test("switching organizations shows only that organization's projects", async ({ browser }) => {
    const { api, home, second, homeProject, sideProject } = await personWithTwoOrganizations();
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    await page.goto(`/${home.slug}`);
    await expect(page).toHaveURL(new RegExp(`/${home.slug}/${homeProject.slug}`));
    await expect(page.locator(".workspace-project")).toContainText(homeProject.name);
    await page.locator(".organization-trigger").click();
    await page.getByRole("menuitem", { name: new RegExp(second.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/${second.slug}/${sideProject.slug}`));
    await expect(page.locator(".workspace-project")).toContainText(sideProject.name);
    await expect(page.locator(".organization-trigger")).toContainText(second.name);
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
    const api = await signUp(email);
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(`${base}/welcome`);
    await expect(page.getByRole("heading", { name: "No organization yet" })).toBeVisible();
    const invitation = await invite(inviter, second.id, email);
    // On a server without email verification, the team shares the private link.
    await page.reload();
    await expect(page.getByRole("link", { name: `Join ${second.name}` })).toHaveCount(0);
    await page.goto(`/join/${invitation.id}`);
    await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
    await page.goto("/welcome");
    await expect(page.getByRole("button", { name: "Create organization" })).toBeEnabled();
    await page.getByLabel("Organization name").fill(`Newcomer ${run}`);
    await page.getByRole("button", { name: "Create organization" }).click();
    // The new organization has no projects yet.
    await expect(page).toHaveURL(`${base}/new`);
    await expect(page.getByRole("contentinfo")).toContainText(`Newcomer ${run}`);
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

// An organization without projects opens on creating its first one, wherever the person goes.
test.describe("first project", () => {
  test("an organization without projects opens the new-project page", async ({ browser }, info) => {
    const email = `first-light-${run}@example.com`;
    const api = await signUp(email);
    const org = await createTestOrganization(api, `First light ${run}`);
    const context = await browser.newContext({ storageState: await api.storageState() });
    const page = await context.newPage();
    // Organization settings stay reachable without a project.
    await page.goto("/settings/members");
    await expect(page).toHaveURL(`${base}/settings/members`);
    await page.goto("/events");
    await expect(page).toHaveURL(`${base}/new`);
    await expect(page.getByRole("heading", { name: "Create your first project" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText(org?.name as string);
    await expect(page.getByRole("button", { name: "Create project" })).toBeEnabled();
    await page.getByLabel("Project name").fill(`First light ${run}`);
    // Its source is named on the same screen, with an icon of its own.
    const input = page.getByLabel("Source", { exact: true });
    const counting = page.getByRole("combobox", { name: "Visitor counting" });
    await input.fill("Website");
    await page.getByLabel("Websites", { exact: true }).fill("*.example.com\n*.example.org");
    const icon = page.getByRole("button", { name: "Source icon: Website", exact: true });
    for (const width of [1600, 1024, 840, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: info.outputPath(`new-project-${width}.png`) });
      const main = (await page.getByRole("main").boundingBox())!;
      const rail = page.locator('[data-slot="project-artwork"]');
      const panelWidth = (await rail.boundingBox())?.x ?? width;
      expect(Math.abs(main.x - (panelWidth - main.x - main.width))).toBeLessThan(2);
      const field = (await input.boundingBox())!,
        button = (await icon.boundingBox())!;
      expect(button.x).toBeGreaterThan(field.x + field.width / 2);
      expect(button.x + button.width).toBeLessThanOrEqual(field.x + field.width);
      expect(field.width).toBeLessThanOrEqual(353);
      expect((await counting.boundingBox())!.width).toBeLessThanOrEqual(225);
      if (width === 1600 || width === 390) {
        await counting.click();
        await expect(page.getByRole("option", { name: "Returning visitors" })).toBeVisible();
        await page.screenshot({ path: info.outputPath(`visitor-counting-${width}.png`) });
        expect((await page.getByRole("listbox").boundingBox())!.width).toBeLessThan(250);
        await page.keyboard.press("Escape");
      }
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await icon.click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(counting).toHaveText("Don’t count visitors");
    await counting.click();
    await page.getByRole("option", { name: "Daily visitors" }).click();
    await counting.click();
    await page.getByRole("option", { name: "Don’t count visitors" }).click();
    await counting.click();
    await page.getByRole("option", { name: "Returning visitors" }).click();
    const create = page.getByRole("button", { name: "Create project" });
    const formBox = (await page.locator("form.auth-form").boundingBox())!;
    const createBox = (await create.boundingBox())!;
    expect(Math.abs(formBox.x + formBox.width - createBox.x - createBox.width)).toBeLessThan(2);
    await create.click();
    await expect(page.getByRole("heading", { name: `First light ${run} is ready` })).toBeVisible();
    const openProject = page.getByRole("link", { name: "Open project", exact: true });
    expect(await openProject.boundingBox()).toEqual(createBox);
    const [project] = await (await api.get("/api/products")).json();
    expect(project.website_urls).toEqual([]);
    await expect(page).toHaveURL(`${base}/new`);
    const key = (await page.getByTestId("ingestion-key").textContent()) as string;
    await expect(page.locator(".integration-code")).toBeHidden();
    await page.getByText("View SDK install guide", { exact: true }).click();
    expect(key).toMatch(/^pk_/);
    await expect(page.locator(".integration-code")).toContainText(key);
    await expect(page.locator(".integration-code")).toContainText("registerAnalyticsConsent");
    const customize = page.getByText("Customize consent snippet", { exact: true });
    await customize.click();
    await page.getByLabel("Who asks for permission?").click();
    await page.getByRole("option", { name: "My site already asks" }).click();
    await expect(page.locator(".integration-code")).toContainText("analyticsConsentChanged");
    await expect(page.getByText("Prompt preview")).toHaveCount(0);
    await page.getByLabel("Who asks for permission?").click();
    await page.getByRole("option", { name: "Ask with Highkey" }).click();
    await page.getByLabel("Layout", { exact: true }).click();
    await page.getByRole("option", { name: "Corner card" }).click();
    await page.getByLabel("Theme", { exact: true }).click();
    await page.getByRole("option", { name: "Light", exact: true }).click();
    await expect(
      page.locator('.hk-consent[data-preview][data-theme="light"][data-layout="corner"]'),
    ).toBeVisible();
    await expect(page.locator(".integration-code")).toContainText(
      'layout: "corner", theme: "light"',
    );
    await customize.click();
    const connection = page.getByRole("status", { name: "Source connection" });
    const sourcesAfterPreview = await (await api.get(`/api/products/${project.id}/sources`)).json();
    const website = sourcesAfterPreview.find((s: { name: string }) => s.name === "Website");
    expect(website.visitor_mode).toBe("persistent");
    expect(website.website_urls).toEqual(["https://*.example.com", "https://*.example.org"]);
    expect(website).not.toHaveProperty("consent_prompt");
    expect(website).not.toHaveProperty("consent_theme");
    await expect(connection).toContainText("Waiting for the first event from Website");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath("connect-390.png") });
    await expect(connection).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.screenshot({ path: info.outputPath("connect-1280.png") });
    await page.getByRole("combobox", { name: "Install framework" }).click();
    await page.getByRole("option", { name: "Next.js", exact: true }).click();
    await expect(page.getByText(/Save the module below as public\/highkey.mjs/)).toBeVisible();
    await page.getByText("Install with AI", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy install prompt" })).toBeVisible();
    const ingested = await fetch(`${process.env.HIGHKEY_API_URL}/api/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json; highkey-sdk=typescript",
      },
      body: JSON.stringify({
        name: "setup_check",
        event_id: crypto.randomUUID(),
        source: "backend",
      }),
    });
    expect(ingested.ok).toBe(true);
    await expect(connection).toContainText("First event received", {
      timeout: 15000,
    });
    await expect(connection).toContainText("Website sent setup_check.");
    await page.getByText("Connect an agent (optional)", { exact: true }).click();
    await expect(
      page.getByText(`claude mcp add --transport http highkey ${base}/mcp`),
    ).toBeVisible();
    await openProject.click();
    await expect(page).toHaveURL(new RegExp(`/${org?.slug}/first-light-${run}`));
    await expect(page.locator(".workspace-project")).toContainText(`First light ${run}`);
    const sources = page.getByRole("navigation", { name: "Project sources" });
    await expect(sources).toContainText("Website");
    await expect(sources.locator('[data-source-icon="terminal"]')).toHaveCount(1);
    const picker = page.getByRole("combobox", { name: "Select project" });
    await expect(picker).toBeEnabled();
    await picker.press("ArrowDown");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("End");
    await expect(page.getByRole("option", { name: "New project", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${base}/new`);
    await expect(
      page.getByRole("heading", { name: "Create a project", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Websites", { exact: true })).toBeVisible();
    await context.close();
  });

  test("a member is told who can create the first project", async ({ browser }) => {
    const owner = await signUp(`empty-owner-${run}@example.com`);
    const org = await createTestOrganization(owner, `Empty ${run}`);
    const email = `empty-member-${run}@example.com`;
    const invitation = await invite(owner, org?.id as string, email);
    const member = await signUp(email);
    expect(
      (
        await member.post("/api/auth/organization/accept-invitation", {
          data: { invitationId: invitation.id },
        })
      ).ok(),
    ).toBe(true);
    const context = await browser.newContext({ storageState: await member.storageState() });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(`${base}/new`);
    await expect(page.getByText("Ask an owner or admin to create one")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
    const switchOrg = page.getByRole("link", { name: "Switch", exact: true });
    await switchOrg.hover();
    await expect(switchOrg).toHaveCSS("text-decoration-line", "underline");
    await switchOrg.click();
    await expect(page).toHaveURL(`${base}/welcome`);
    await context.close();
  });
});
