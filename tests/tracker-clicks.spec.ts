import { expect, test } from "@playwright/test";
import type { Event } from "../sdk/typescript/client";

test("click collection is opt-in, sanitized, and leaves navigation alone", async ({ page }) => {
  const response = await fetch(
    `${process.env.HIGHKEY_DASHBOARD_URL ?? "http://127.0.0.1:3000"}/tracker.js`,
  );
  expect(response.ok).toBe(true);
  const source = await response.text();
  const events: Event[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/tracker.js")
        return new Response(source, { headers: { "content-type": "application/javascript" } });
      if (request.method === "POST") {
        const batch = (await request.json()).events as Event[];
        events.push(...batch);
        return Response.json({ accepted: batch.length, duplicates: 0 });
      }
      return new Response("<html><body></body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  try {
    await page.goto(String(server.url));
    const result = await page.evaluate(async () => {
      const trackerUrl = "/tracker.js";
      const { startBrowserTracker } = await import(trackerUrl);
      const options = { endpoint: location.origin, key: "public", collectReferrer: false };
      const link = document.createElement("a");
      link.href = "https://user:password@other.example/docs?token=secret#private";
      link.innerHTML = "<span>Docs</span>";
      const button = document.createElement("button");
      button.dataset.track = "signup";
      button.dataset.plan = "pro";
      button.dataset.seats = "3";
      button.innerHTML = "<span>Sign up</span>";
      document.body.append(link, button);
      const click = (element: Element | null, type = "click", button = 0) => {
        if (!element) throw new Error("Missing click fixture");
        let prevented = false;
        // Observe the tracker before suppressing the fixture's actual navigation.
        const cancel = (event: globalThis.Event) => {
          prevented = event.defaultPrevented;
          event.preventDefault();
        };
        element.addEventListener(type, cancel, { once: true });
        element.dispatchEvent(
          new MouseEvent(type, { button, bubbles: true, cancelable: true, composed: true }),
        );
        return prevented;
      };
      let tracker = startBrowserTracker(options);
      click(link.firstElementChild);
      click(button.firstElementChild);
      await tracker.shutdown();
      tracker = startBrowserTracker({
        ...options,
        trackOutboundLinks: true,
        trackAttributes: true,
        beforeSend: (event: Event) => {
          if (event.name === "signup") event.properties = { ...event.properties, plan: "reviewed" };
          return event;
        },
      });
      const prevented = click(link.firstElementChild);
      click(link, "auxclick", 1);
      click(link, "auxclick", 2);
      click(button.firstElementChild);
      button.dataset.track = "invalid event name";
      click(button);
      for (const href of [
        "/internal",
        "#anchor",
        "mailto:private@example.com",
        "javascript:void(0)",
        "http://[",
      ]) {
        link.setAttribute("href", href);
        click(link);
      }
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<button data-track="shadow_click" data-plan="pro">Nested</button>';
      click(shadow.querySelector("button"));
      await tracker.flush();
      tracker.optOut();
      button.dataset.track = "after_opt_out";
      click(button);
      await tracker.flush();
      return { prevented };
    });
    expect(result.prevented).toBe(false);
    expect(events.map(({ name, properties }) => ({ name, properties }))).toEqual([
      { name: "page_view", properties: { path: "/" } },
      { name: "page_view", properties: { path: "/" } },
      { name: "link_out", properties: { url: "https://other.example/docs", text: "Docs" } },
      { name: "link_out", properties: { url: "https://other.example/docs", text: "Docs" } },
      { name: "signup", properties: { plan: "reviewed", seats: "3" } },
      { name: "shadow_click", properties: { plan: "pro" } },
    ]);
  } finally {
    await server.stop(true);
  }
});
