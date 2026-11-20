import { afterEach, expect, test } from "bun:test";
import { browserGcTime } from "../apps/app/src/lib/cache-time";
import { dashboardQuery } from "../apps/app/src/server/dashboards";

const scope = globalThis as { window?: unknown };
afterEach(() => {
  delete scope.window;
});

test("queries keep their cache lifetime in the browser and never schedule a timer on the server", () => {
  // Bun has no window, like the server render.
  expect(browserGcTime(600_000)).toBe(Number.POSITIVE_INFINITY);
  expect(dashboardQuery("project", "dashboard").gcTime).toBe(Number.POSITIVE_INFINITY);
  scope.window = {};
  expect(browserGcTime(600_000)).toBe(600_000);
  expect(dashboardQuery("project", "dashboard").gcTime).toBe(30 * 60_000);
});
