// The API runs in the dashboard's own process: every /api request but ingestion is answered here.
import { apiContext } from "./context";
import { handleApi } from "./router";

/** Answers one API request with this process's context. */
export function serveApi(request: Request): Promise<Response> {
  return handleApi(request, apiContext());
}

/**
 * An API request made while rendering a page, as the visitor: it carries their cookies, so the
 * answer is what their session may see. The host is loopback, which the router always accepts.
 */
export function visitorRequest(incoming: Request, path: string): Request {
  const cookie = incoming.headers.get("cookie");
  return new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
}
