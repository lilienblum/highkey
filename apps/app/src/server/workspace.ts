import { createServerFn } from "@tanstack/react-start";
import type { Product } from "../lib/api";
import { Err } from "../lib/error-codes";

/** Why the signed-in person cannot open their organization's workspace right now. */
export type WorkspaceBlock = "no_organization" | "not_a_member" | "two_factor_required";
const BLOCKS: ReadonlySet<string> = new Set<WorkspaceBlock>([
  "no_organization",
  "not_a_member",
  "two_factor_required",
]);

type Workspace = { products: Product[] } | { blocked: WorkspaceBlock } | { errorCode: Err };

export async function readWorkspaceResponse(response: Response): Promise<Workspace> {
  // The person's standing, not an outage: the page says what to do instead.
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as { code?: string } | null;
    if (body?.code && BLOCKS.has(body.code)) return { blocked: body.code as WorkspaceBlock };
  }
  if (!response.ok) {
    console.error(`[${Err.WorkspaceLoadFailed}] GET /api/products returned ${response.status}`);
    return { errorCode: Err.WorkspaceLoadFailed };
  }
  const projects = await response.json().catch(() => null);
  if (!Array.isArray(projects)) {
    console.error(
      `[${Err.WorkspaceInvalidResponse}] GET /api/products did not return a project list`,
    );
    return { errorCode: Err.WorkspaceInvalidResponse };
  }
  return { products: projects as Product[] };
}

export const getWorkspace = createServerFn({ method: "GET" }).handler(async () => {
  const { serveApi, visitorRequest } = await import("./api/serve");
  const { getRequest } = await import("@tanstack/react-start/server");
  return readWorkspaceResponse(await serveApi(visitorRequest(getRequest(), "/api/products")));
});
