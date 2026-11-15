// Routes for every non-ingestion /api path. Modules register their routes with `route`; the
// dashboard's /api/$ route calls `handleApi`.
import type { ApiContext } from "./context";
import { preflight, withReadCors } from "./cors";
import { dashboardResponse } from "../dashboards/errors";
import { ApiError, errorResponse, json } from "./errors";

export type Handler = (
  request: Request,
  ctx: ApiContext,
  params: Record<string, string>,
) => Promise<Response>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const routes: Route[] = [];
let registered = false;

/** Registers every module's routes once. */
async function ensureRoutes(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerManagement } = await import("./management");
  const { registerQueries } = await import("../queries/routes");
  const { registerDashboards } = await import("../dashboards/routes");
  registerManagement();
  registerQueries();
  registerDashboards();
}

/** Registers a route; `:name` segments become params. Registration order breaks ties. */
export function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
}

function match(parts: string[], path: string[]): Record<string, string> | null {
  if (parts.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const segment = path[i] as string;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segment);
    else if (part !== segment) return null;
  }
  return params;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

/** Whether a path is a management path, which needs the CSRF marker on writes. */
function managed(pathname: string): boolean {
  return !pathname.startsWith("/api/read/") && pathname !== "/api/mcp";
}

export async function handleApi(request: Request, ctx: ApiContext): Promise<Response> {
  await ensureRoutes();
  const url = new URL(request.url);
  const read = url.pathname.startsWith("/api/read/");
  if (read && request.method === "OPTIONS") return secured(preflight(request, ctx.corsOrigins));
  const path = url.pathname.split("/").filter(Boolean);
  let allowed = false;
  for (const candidate of routes) {
    const params = match(candidate.parts, path);
    if (!params) continue;
    allowed = true;
    if (candidate.method !== request.method) continue;
    let response: Response;
    try {
      // This is a CSRF request marker, not authentication; the edge controls access.
      if (
        managed(url.pathname) &&
        request.method !== "GET" &&
        request.headers.get("x-piko-admin") !== "1"
      )
        throw new ApiError(403, "Management requests require X-Piko-Admin: 1");
      response = await candidate.handler(request, ctx, params);
    } catch (error) {
      // Read and dashboard paths answer with typed bodies (code, errors[].path, hint).
      const typed = read || /\/(dashboards|views)(\/|$)/.test(url.pathname);
      response = (typed ? dashboardResponse(error) : null) ?? errorResponse(error);
    }
    response = secured(response);
    return read ? withReadCors(request, response, ctx.corsOrigins) : response;
  }
  const response = allowed
    ? json({ error: "Method not allowed" }, 405)
    : errorResponse(new ApiError(404, "Product or key not found"));
  return secured(response);
}
