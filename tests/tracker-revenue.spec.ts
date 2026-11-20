import { expect, test, type Page } from "@playwright/test";
import type { Event } from "../sdk/typescript/client";

let source: string;
test.beforeAll(async () => {
  const response = await fetch(`${process.env.HIGHKEY_DASHBOARD_URL}/tracker.js`);
  expect(response.ok).toBe(true);
  source = await response.text();
});

async function fixture(page: Page, options = "") {
  const attempts: Event[] = [];
  let accepting = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/tracker.js")
        return new Response(source, { headers: { "content-type": "application/javascript" } });
      if (path === "/api/ingest") {
        const { events } = (await request.json()) as { events: Event[] };
        attempts.push(...events);
        return accepting
          ? Response.json({ accepted: events.length, duplicates: 0 })
          : Response.json({ error: "offline" }, { status: 503 });
      }
      return new Response(
        `<script type="module">
        import { startBrowserTracker } from '/tracker.js';
        window.tracker = startBrowserTracker({
          endpoint: location.origin, key: 'pk_checkout', retries: 0, collectReferrer: false, ${options}
        });
      </script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  await page.goto(server.url.href);
  await page.waitForFunction(() => !!window.tracker);
  return {
    attempts,
    server,
    accept: () => {
      accepting = true;
    },
  };
}

test("checkout survives navigation and retries with one ID, clearing only after acknowledgment", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(
      await page.evaluate(() => [
        window.tracker.track("bad", { revenue: 1.5 }),
        window.tracker.beginCheckout(1.5),
        window.tracker.beginCheckout(2500),
      ]),
    ).toEqual([false, false, true]);
    await page.goto(new URL("/thanks", f.server.url).href);
    await page.waitForFunction(() => !!window.tracker);
    expect(
      await page.evaluate(async () => {
        const queued = window.tracker.completeCheckout({ path: "/thanks" });
        await window.tracker.flush();
        return queued;
      }),
    ).toBe(true);
    const failed = f.attempts.filter((event) => event.name === "purchase");
    expect(failed).toHaveLength(1);
    expect(failed[0].properties).toEqual({ path: "/thanks", revenue: 2500 });
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toHaveLength(1);
    f.accept();
    await page.reload();
    await page.waitForFunction(() => !!window.tracker);
    await page.evaluate(async () => {
      window.tracker.completeCheckout({ path: "/thanks" });
      await window.tracker.shutdown();
    });
    const purchases = f.attempts.filter((event) => event.name === "purchase");
    expect(purchases).toHaveLength(2);
    expect(purchases[1].event_id).toBe(purchases[0].event_id);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  } finally {
    await f.server.stop(true);
  }
});

test("checkout refuses deferred storage, expires, and is discarded on privacy withdrawal", async ({
  page,
}) => {
  const f = await fixture(page, "defer: true");
  try {
    expect(
      await page.evaluate(() => [
        window.tracker.beginCheckout(100),
        window.tracker.completeCheckout(),
      ]),
    ).toEqual([false, false]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(
      await page.evaluate(() => {
        window.tracker.ready();
        window.tracker.beginCheckout(100);
        const key = Object.keys(sessionStorage)[0];
        const expired = JSON.parse(sessionStorage.getItem(key)!);
        expired.expires = Date.now() - 1;
        sessionStorage.setItem(key, JSON.stringify(expired));
        return window.tracker.completeCheckout();
      }),
    ).toBe(false);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(
      await page.evaluate(() => {
        window.tracker.beginCheckout(100);
        sessionStorage.setItem("application-state", "keep");
        window.tracker.optOut();
        return window.tracker.completeCheckout();
      }),
    ).toBe(false);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(["application-state"]);
    expect(f.attempts.some((event) => event.name === "purchase")).toBe(false);
  } finally {
    await f.server.stop(true);
  }
});
