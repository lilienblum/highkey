import { createServerFn } from "@tanstack/react-start";
import type { StoredDashboard } from "../lib/dashboards";

/** Project and dashboard keys are slugs or UUIDs; anything else cannot name one. */
const key = /^[A-Za-z0-9-]{1,128}$/;

/**
 * One dashboard document for the server render and client navigation. A missing project or
 * dashboard is `null` so the page can offer a way back; any other failure is an error.
 */
export const getDashboard = createServerFn({ method: "GET" })
  .validator((input: { project: string; dashboard: string }) => {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.project !== "string" ||
      typeof input.dashboard !== "string"
    )
      throw new Error("A dashboard needs a project and a dashboard key.");
    return { project: input.project, dashboard: input.dashboard };
  })
  .handler(async ({ data }): Promise<StoredDashboard | null> => {
    if (!key.test(data.project) || !key.test(data.dashboard)) return null;
    const { proxyApi } = await import("./api-gateway");
    const response = await proxyApi(
      new Request(
        `http://localhost/api/read/products/${encodeURIComponent(data.project)}/dashboards/${encodeURIComponent(data.dashboard)}`,
      ),
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        "Could not load this dashboard. Check that the API is running and try again.",
      );
    const dashboard = await response.json();
    if (!dashboard || typeof dashboard !== "object" || !Array.isArray(dashboard.document?.widgets))
      throw new Error("The API returned an invalid dashboard.");
    return dashboard as StoredDashboard;
  });
