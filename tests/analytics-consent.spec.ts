import { test, expect } from "@playwright/test";
import type { registerAnalyticsConsent } from "../sdk/typescript/consent";
declare global {
  interface Window {
    consent: ReturnType<typeof registerAnalyticsConsent>;
  }
}
let moduleSource: string;
test.beforeAll(async () => {
  const r = await fetch(`${process.env.HIGHKEY_DASHBOARD_URL}/tracker.js`);
  expect(r.ok).toBe(true);
  moduleSource = await r.text();
});
function fixture(mode = "persistent", layout = "bar", theme = "auto") {
  const events: { name: string; actor_id?: string; properties: { path?: string } }[] = [];
  let checks = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/tracker.js")
        return new Response(moduleSource, {
          headers: { "content-type": "application/javascript" },
        });
      if (path === "/api/ingest") {
        if (req.method === "GET") {
          checks++;
          return Response.json({ visitor_mode: mode });
        }
        events.push(...(await req.json()).events);
        return Response.json({ accepted: 1, duplicates: 0 });
      }
      return new Response(
        `<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body {font:16px system-ui;} .dark {--card:#222233;--card-foreground:#eeeeff;} .hk-consent {--hk-consent-radius:18px;}
</style><body><button type="button" data-highkey-privacy>Privacy preferences</button>
<script type="module">import {registerAnalyticsConsent} from '/tracker.js';
window.consent=registerAnalyticsConsent({key:'pk_consent',endpoint:location.origin,appearance:{layout:'${layout}',theme:'${theme}'}});
</script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return { server, events, checks: () => checks };
}
test("visitors control returning-visitor analytics, including withdrawal from another tab", async ({
  page,
  context,
}, info) => {
  const f = fixture();
  try {
    await page.goto(f.server.url.href);
    const prompt = page.getByRole("dialog", { name: "Allow visitor analytics?" });
    await expect(prompt).toBeVisible();
    await page.evaluate(() => {
      history.pushState({}, "", "/before");
      window.consent.tracker?.track("before");
    });
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(f.events).toEqual([]);
    await expect(prompt).toHaveCSS("border-radius", "18px");
    await page.screenshot({ path: info.outputPath("bar-light.png") });
    await prompt.getByRole("button", { name: "Decline" }).click();
    await page.reload();
    await page.evaluate(() => window.consent.ready);
    await expect(prompt).toHaveCount(0);
    expect(await page.evaluate(() => Object.values(localStorage))).toEqual(["decline"]);
    await page.evaluate(() => history.pushState({}, "", "/after"));
    await page.getByRole("button", { name: "Privacy preferences" }).click();
    await expect(prompt.getByRole("button", { name: "Decline" })).toBeFocused();
    await prompt.getByRole("button", { name: "Allow" }).click();
    await expect(page.getByRole("button", { name: "Privacy preferences" })).toBeFocused();
    await page.evaluate(async () => {
      window.consent.tracker!.track("allowed");
      await window.consent.tracker!.flush();
    });
    expect(f.events.map((e) => e.name)).toEqual(["page_view", "allowed"]);
    expect(f.events[0].properties.path).toBe("/after");
    expect(f.events[0].actor_id).toBeTruthy();
    const other = await context.newPage();
    await other.goto(f.server.url.href);
    await other.evaluate(() => window.consent.ready);
    await other.evaluate(() => window.consent.tracker!.flush());
    expect(f.events.at(-1)?.actor_id).toBe(f.events[0].actor_id);
    await other.getByRole("button", { name: "Privacy preferences" }).click();
    await other.getByRole("button", { name: "Decline", exact: true }).click();
    await page.waitForFunction(() => window.consent.tracker === undefined);
    expect(await page.evaluate(() => Object.values(localStorage))).toEqual(["decline"]);
    await other.close();
  } finally {
    await f.server.stop(true);
  }
});

for (const scenario of ["off", "cookieless", "offline", "DNT", "GPC"] as const)
  test(`consent is inert for ${scenario}`, async ({ page }) => {
    const f = fixture(scenario === "DNT" || scenario === "GPC" ? "persistent" : scenario);
    try {
      if (scenario === "GPC" || scenario === "DNT")
        await page.addInitScript(
          (signal) =>
            Object.defineProperty(
              navigator,
              signal === "GPC" ? "globalPrivacyControl" : "doNotTrack",
              { value: signal === "GPC" ? true : "1" },
            ),
          scenario,
        );
      if (scenario === "offline") await page.route("**/api/ingest", (route) => route.abort());
      await page.goto(f.server.url.href);
      await page.evaluate(() => window.consent.ready);
      await page.getByRole("button", { name: "Privacy preferences" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(
        await page.evaluate(() => [!!window.consent.tracker, ...Object.keys(localStorage)]),
      ).toEqual([false]);
      expect(f.events).toEqual([]);
      if (scenario === "DNT" || scenario === "GPC") expect(f.checks()).toBe(0);
    } finally {
      await f.server.stop(true);
    }
  });

test("corner card follows shadcn tokens, fits mobile, and can be torn down before a choice", async ({
  page,
}, info) => {
  const f = fixture("persistent", "corner");
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(f.server.url.href);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    const prompt = page.getByRole("dialog");
    await expect(prompt).toHaveCSS("background-color", "rgb(34, 34, 51)");
    await expect(prompt).toHaveCSS("color-scheme", "dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.screenshot({ path: info.outputPath("corner-dark-mobile.png") });
    await page.evaluate(() => window.consent.destroy());
    await expect(prompt).toHaveCount(0);
    await page.getByRole("button", { name: "Privacy preferences" }).click();
    await expect(prompt).toHaveCount(0);
    expect(f.events).toEqual([]);
  } finally {
    await f.server.stop(true);
  }
});
