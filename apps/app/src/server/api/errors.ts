// The dashboard API's errors. Management and ingestion-era endpoints answer `{ "error": ... }`
// with the same messages the Rust API used; dashboard paths add codes on top (see
// dashboards/errors.ts).
import { StorageUnavailable } from "../db/db";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
    /** A stable code for programs, sent beside the message when set. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const bad = (message: string) => new ApiError(400, message);
export const unprocessable = (message: string) => new ApiError(422, message);
/** A key, source or route that does not exist. */
export const missing = () => new ApiError(404, "Product or key not found");
export const projectMissing = () => new ApiError(404, "Project not found");
export const sourceMissing = () => new ApiError(404, "Source not found");

/** A project's analytics are not reachable yet: ClickHouse is down or still provisioning. */
export const analyticsUnavailable = () =>
  new ApiError(
    503,
    "Analytics storage is not ready for this project; retry shortly",
    { "Retry-After": "5" },
    "analytics_unavailable",
  );

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Converts anything a handler threw into a response. Unexpected errors are logged, not shown. */
export function errorResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof StorageUnavailable)
    return json(
      { error: "Management storage is unavailable; retry shortly", code: "storage_unavailable" },
      503,
      { "Retry-After": "5" },
    );
  if (error instanceof ApiError) {
    const headers = { ...error.headers };
    if ((error.status === 503 || error.status === 429) && !headers["Retry-After"])
      headers["Retry-After"] = "1";
    const body = error.code ? { error: error.message, code: error.code } : { error: error.message };
    return json(body, error.status, headers);
  }
  console.error("Database operation failed", error);
  return json({ error: "Database operation failed" }, 500);
}
