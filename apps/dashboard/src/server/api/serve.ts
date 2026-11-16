// The API runs in the dashboard's own process: every /api request but ingestion is answered here.
import { apiContext } from "./context";
import { handleApi } from "./router";

/** Answers one API request with this process's context. */
export function serveApi(request: Request): Promise<Response> {
  return handleApi(request, apiContext());
}
