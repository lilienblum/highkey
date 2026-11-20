import { expect, test, type Page } from "@playwright/test";
import type { Event } from "../sdk/typescript/client";

const dashboard = process.env.HIGHKEY_DASHBOARD_URL ?? "http://127.0.0.1:3000";
let source: string;
test.beforeAll(async () => {
  const response = await fetch(`${dashboard}/tracker.js`);
  expect(response.ok).toBe(true);
  source = await response.text();
});

async function fixture(page: Page, options = "") {
  const events: Event[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/tracker.js")
        return new Response(source, { headers: { "content-type": "application/javascript" } });
      if (path === "/api/ingest") {
        const batch = (await request.json()).events as Event[];
        events.push(...batch);
        return Response.json({ accepted: batch.length, duplicates: 0 });
      }
      return new Response(
        `<html><head><title>Private account</title></head><body><script type="module">
          import { startBrowserTracker } from '/tracker.js';
          window.tracker = startBrowserTracker({
            endpoint: location.origin, key: 'public-key', collectReferrer: false, ${options}
          });
        </script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  try {
    await page.goto(`${server.url}app?secret=private#/start`);
    await page.waitForFunction(() => !!window.tracker);
    return { events, server };
  } catch (error) {
    await server.stop(true);
    throw error;
  }
}

async function hash(page: Page, value: string) {
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve) => {
        addEventListener("hashchange", () => resolve(), { once: true });
        location.hash = value;
      }),
    value,
  );
}

for (const signal of ["disabled", "dnt", "gpc"] as const) {
  test(`${signal} blocks opted-in titles and hash routes`, async ({ page }) => {
    await page.addInitScript((signal) => {
      if (signal === "dnt") Object.defineProperty(navigator, "doNotTrack", { value: "1" });
      if (signal === "gpc")
        Object.defineProperty(navigator, "globalPrivacyControl", { value: true });
    }, signal);
    const f = await fixture(
      page,
      `collectTitle: true, trackHashChanges: true, enabled: ${signal !== "disabled"}`,
    );
    try {
      await hash(page, "/private");
      expect(await page.evaluate(() => window.tracker.pageView())).toBe(false);
      await page.evaluate(() => window.tracker.shutdown());
      expect(f.events).toEqual([]);
    } finally {
      await f.server.stop(true);
    }
  });
}

test("titles and hash-only page views stay off by default", async ({ page }) => {
  const f = await fixture(page);
  try {
    await hash(page, "/private");
    await page.evaluate(async () => {
      history.pushState({}, "", "#/another-private-route");
      history.replaceState({}, "", "#/replaced-private-route");
      await window.tracker.shutdown();
    });
    expect(f.events).toHaveLength(1);
    expect(f.events[0].properties).toEqual({ path: "/app" });
  } finally {
    await f.server.stop(true);
  }
});

test("opted-in hash navigation counts each route once and captures its current title", async ({
  page,
}) => {
  const f = await fixture(page, "collectTitle: true, trackHashChanges: true");
  try {
    await page.evaluate(() => {
      document.title = "Settings";
    });
    await hash(page, "/settings");
    await page.evaluate(() => {
      document.title = "Billing";
      history.pushState({}, "", "#/billing");
      history.replaceState({}, "", "#/billing");
      // A title-only change is not a navigation.
      document.title = "Updated billing";
      history.pushState({}, "", "#/billing");
      document.title = "Plans";
      history.replaceState({}, "", "#/plans");
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          document.title = "Back to billing";
          addEventListener("hashchange", () => resolve(), { once: true });
          history.back();
        }),
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          document.title = "Forward to plans";
          addEventListener("hashchange", () => resolve(), { once: true });
          history.forward();
        }),
    );
    await page.evaluate(() => window.tracker.shutdown());
    expect(f.events.map((event) => event.properties)).toEqual([
      { path: "/app#/start", title: "Private account" },
      { path: "/app#/settings", title: "Settings" },
      { path: "/app#/billing", title: "Billing" },
      { path: "/app#/plans", title: "Plans" },
      { path: "/app#/billing", title: "Back to billing" },
      { path: "/app#/plans", title: "Forward to plans" },
    ]);
    await hash(page, "/after-shutdown");
    await page.evaluate(() => window.tracker.flush());
    expect(f.events).toHaveLength(6);
  } finally {
    await f.server.stop(true);
  }
});

test("titles and hash routes go through sanitizers and stop collecting on opt-out", async ({
  page,
}) => {
  const f = await fixture(
    page,
    `collectTitle: true, trackHashChanges: true,
    sanitizePath: path => {
      if (path.includes('throw')) throw new Error('invalid route');
      return path.includes('#/users/') ? '/app#/users/:id' : null;
    },
    beforeSend: event => {
      if (event.properties.title === 'Drop me') return null;
      event.properties.title = event.properties.title.replace('Private', 'Reviewed');
      return event;
    }`,
  );
  try {
    await hash(page, "/users/private@example.com?token=secret");
    await hash(page, "/throw");
    await page.evaluate(() => {
      document.title = "Drop me";
    });
    await hash(page, "/drop");
    await page.evaluate(async () => {
      document.title = "🌊".repeat(1000);
      window.tracker.pageView();
      await window.tracker.flush();
    });
    expect(f.events.map((event) => event.properties)).toEqual([
      { title: "Reviewed account" },
      { path: "/app#/users/:id", title: "Reviewed account" },
      { title: "🌊".repeat(256) },
    ]);
    await hash(page, "/queued");
    await page.evaluate(() => window.tracker.optOut());
    await hash(page, "/after-opt-out");
    await page.evaluate(() => window.tracker.flush());
    expect(f.events).toHaveLength(3);
  } finally {
    await f.server.stop(true);
  }
});
