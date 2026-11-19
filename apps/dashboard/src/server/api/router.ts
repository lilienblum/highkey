// Routes for every non-ingestion /api path. Modules register their routes with `route`, each with
// the permission it needs; the dashboard's /api/$ route calls `handleApi`, which resolves who is
// asking, checks that permission, and resolves any project in the path within the asker's
// organization before a handler runs, so no handler can skip those checks.
import { type Actor, resolveActor, withAccessToken } from "../auth/actor";
import { oauthAvailable } from "../auth/auth";
import { keyFrom } from "../auth/keys";
import { can, type Permission } from "../auth/roles";
import { resolveProduct } from "../db/products";
import type { ApiContext } from "./context";
import { preflight, withReadCors } from "./cors";
import { dashboardResponse } from "../dashboards/errors";
import { ApiError, errorResponse, json } from "./errors";

export type Handler = (
  request: Request,
  ctx: ApiContext,
  params: Record<string, string>,
) => Promise<Response>;

/** What a route needs: a permission from the role table, or the server admin. */
export type Need = Permission | "server-admin";

/** Read access, which every role has. */
export const READ: Need = { read: ["all"] };

interface Route {
  method: string;
  pattern: string;
  parts: string[];
  need: Need;
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
  const { registerViews } = await import("../views");
  const { registerMcp } = await import("../mcp/server");
  const { registerApiKeys } = await import("../auth/key-routes");
  const { registerConnections } = await import("../auth/connections");
  registerManagement();
  registerApiKeys();
  registerConnections();
  registerQueries();
  registerDashboards();
  registerViews();
  registerMcp();
}

/**
 * Registers a route; `:name` segments become params. Registration order breaks ties. `:id` and
 * `:project` always name a project, and reach the handler as that project's id.
 */
export function route(method: string, pattern: string, need: Need, handler: Handler): void {
  routes.push({ method, pattern, parts: pattern.split("/").filter(Boolean), need, handler });
}

/** Every registered route, for the access tests. */
export async function registeredRoutes(): Promise<
  { method: string; pattern: string; need: Need }[]
> {
  await ensureRoutes();
  return routes.map(({ method, pattern, need }) => ({ method, pattern, need }));
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Requests name Highkey's public host, or loopback; anything else is a rebinding attempt. */
function hostAllowed(url: URL, ctx: ApiContext): boolean {
  return url.host === new URL(ctx.publicUrl).host || LOOPBACK.has(url.hostname);
}

/** A write from a browser session comes from Highkey's own pages (or loopback in development). */
function originAllowed(origin: string | null, ctx: ApiContext): boolean {
  if (!origin) return false;
  try {
    const from = new URL(origin);
    return from.origin === new URL(ctx.publicUrl).origin || LOOPBACK.has(from.hostname);
  } catch {
    return false;
  }
}

export async function handleApi(request: Request, ctx: ApiContext): Promise<Response> {
  await ensureRoutes();
  const url = new URL(request.url);
  const read = url.pathname.startsWith("/api/read/");
  if (read && request.method === "OPTIONS") return secured(preflight(request, ctx.corsOrigins));
  const finish = (response: Response) => {
    const out = secured(response);
    return read ? withReadCors(request, out, ctx.corsOrigins) : out;
  };
  if (!hostAllowed(url, ctx))
    return finish(json({ error: "This host does not serve Highkey", code: "wrong_host" }, 421));
  const path = url.pathname.split("/").filter(Boolean);
  let allowed = false;
  for (const candidate of routes) {
    const params = match(candidate.parts, path);
    if (!params) continue;
    allowed = true;
    if (candidate.method !== request.method) continue;
    const proceed = async (actor: Actor): Promise<Response> => {
      const writes = request.method !== "GET" && request.method !== "HEAD";
      // MCP refuses any request with an Origin itself (browsers never call it), so only the other
      // paths need a session's writes to come from Highkey's own pages.
      const mcp = url.pathname === "/api/mcp" || url.pathname === "/api/read/mcp";
      const origin = request.headers.get("origin");
      if (writes && actor.via === "session" && !mcp && !originAllowed(origin, ctx))
        throw new ApiError(403, "Cross-site requests cannot change Highkey", {}, "cross_site");
      const allowed =
        candidate.need === "server-admin" ? actor.serverAdmin : can(actor.role, candidate.need);
      // A read-only credential (a read key, or any key of a viewer) only reaches read routes.
      const changes = candidate.need === "server-admin" || !("read" in candidate.need);
      if (!allowed || (changes && actor.access === "read"))
        throw new ApiError(
          403,
          "Your role or this credential does not allow this",
          {},
          "forbidden",
        );
      for (const name of ["id", "project"])
        if (params[name] !== undefined)
          params[name] = (await resolveProduct(ctx.db, params[name] as string, actor.orgId)).id;
      return candidate.handler(request, { ...ctx, actor }, params);
    };
    let response: Response;
    try {
      const key = keyFrom(request.headers) !== null;
      // /api/mcp takes agents' OAuth tokens or API keys; /api/read/mcp, API keys only (scheduled
      // and CI runs, which cannot sign in). Neither takes a browser session.
      if (url.pathname === "/api/mcp" && !key && !oauthAvailable(ctx.publicUrl))
        throw new ApiError(
          401,
          "Agents sign in over OAuth only when Highkey is served over HTTPS; connect with an API key",
          {},
          "unauthenticated",
        );
      if (url.pathname === "/api/mcp" && !key)
        response = await withAccessToken(ctx, request, proceed);
      else if (url.pathname === "/api/read/mcp" && !key)
        throw new ApiError(
          401,
          "Connect to /api/read/mcp with an API key (a read-only one is enough)",
          {},
          "unauthenticated",
        );
      else response = await proceed(await resolveActor(ctx, request));
    } catch (error) {
      // Read and dashboard paths answer with typed bodies (code, errors[].path, hint).
      const typed = read || /\/(dashboards|views)(\/|$)/.test(url.pathname);
      response = (typed ? dashboardResponse(error) : null) ?? errorResponse(error);
    }
    return finish(response);
  }
  const response = allowed
    ? json({ error: "Method not allowed" }, 405)
    : errorResponse(new ApiError(404, "Product or key not found"));
  return secured(response);
}
