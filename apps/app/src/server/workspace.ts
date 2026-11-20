import { createServerFn } from "@tanstack/react-start";
import type { Product } from "../lib/api";

/** Why the signed-in person cannot open their organization's workspace right now. */
export type WorkspaceBlock = "no_organization" | "not_a_member" | "two_factor_required";
const BLOCKS: ReadonlySet<string> = new Set<WorkspaceBlock>([
  "no_organization",
  "not_a_member",
  "two_factor_required",
]);

export const getWorkspace = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ products: Product[] } | { blocked: WorkspaceBlock }> => {
    const { serveApi, visitorRequest } = await import("./api/serve");
    const { getRequest } = await import("@tanstack/react-start/server");
    const response = await serveApi(visitorRequest(getRequest(), "/api/products"));
    // The person's standing, not an outage: the page says what to do instead.
    if (response.status === 403) {
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      if (body?.code && BLOCKS.has(body.code)) return { blocked: body.code as WorkspaceBlock };
    }
    if (!response.ok)
      throw new Error(
        "Could not load the workspace. Check that ClickHouse is running and try again.",
      );
    const projects = await response.json();
    if (!Array.isArray(projects)) throw new Error("The API returned an invalid project list.");
    return { products: projects as Product[] };
  },
);
