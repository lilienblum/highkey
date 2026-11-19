// Errors from dashboard reads, runs and writes, with typed JSON bodies: `error` for the message,
// like every other API error, plus a `code`. HTTP responses and MCP tool errors are both built
// from `parts`, so they cannot disagree.
import { ApiError } from "../api/errors";
import type { Issue, Report } from "./validate";

export class DashboardError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly retryAfter: number | null = null,
    /** A timeout spent waiting for a query slot, which is Highkey's load rather than the widget's cost. */
    readonly queued = false,
  ) {
    super(String(body.error));
    this.name = "DashboardError";
  }
}

export function notFound(what: string, hint: string | null): DashboardError {
  const name = what.toLowerCase();
  return new DashboardError(404, {
    error: `${what} not found`,
    code: "not_found",
    errors: [{ message: `No ${name} matches that id or slug`, path: `/${name}`, hint }],
  });
}

export const invalid = (report: Report, kind: "dashboard" | "view" = "dashboard") =>
  new DashboardError(400, {
    error: `Invalid ${kind} document`,
    code: "invalid_document",
    errors: report.errors,
    warnings: report.warnings,
  });

export const conflict = (revision: number) =>
  new DashboardError(409, {
    error: "This dashboard changed since you loaded it",
    code: "revision_conflict",
    revision,
  });

export const limit = (message: string) =>
  new DashboardError(400, { error: message, code: "limit" });

export const timedOut = (afterMs: number, queued = false) =>
  new DashboardError(
    503,
    { error: `Timed out after ${afterMs / 1000} s`, code: "query_timeout" },
    null,
    queued,
  );

export const tooSlow = (report: Report) =>
  new DashboardError(400, {
    error: "A widget is too slow to save",
    code: "too_slow",
    errors: report.errors,
    warnings: report.warnings,
  });

export const busyBench = (report: Report) =>
  new DashboardError(
    503,
    {
      error: "Highkey was busy running other queries",
      code: "busy",
      errors: report.errors,
      warnings: report.warnings,
    },
    5,
  );

export const rateLimited = (retryAfter: number) =>
  new DashboardError(
    429,
    {
      error: "Too many dashboard writes; slow down",
      code: "rate_limited",
      errors: [
        {
          path: "",
          message: "Too many dashboard writes for this project",
          hint: `Retry after ${retryAfter} s`,
        },
      ],
    },
    retryAfter,
  );

export const detailed = (status: number, message: string, code: string, errors: Issue[]) =>
  new DashboardError(status, { error: message, code, errors });

/** The status, body and Retry-After seconds of anything a dashboard path threw. */
export function parts(
  error: unknown,
): { status: number; body: Record<string, unknown>; retryAfter: number | null } | null {
  if (error instanceof DashboardError)
    return { status: error.status, body: error.body, retryAfter: error.retryAfter };
  if (error instanceof ApiError) {
    if (error.status === 503 && error.code !== "analytics_unavailable")
      return {
        status: 503,
        body: {
          error: "Highkey is busy; retry shortly",
          code: "busy",
          errors: [{ path: "", message: "Every query slot is in use", hint: "Retry after 1 s" }],
        },
        retryAfter: 1,
      };
    if (error.status === 404 && error.message === "Project not found") {
      const e = notFound(
        "Project",
        "List the projects with list_projects or GET /api/read/products, and pass an id or slug",
      );
      return { status: e.status, body: e.body, retryAfter: null };
    }
  }
  return null;
}

export function dashboardResponse(error: unknown): Response | null {
  const found = parts(error);
  if (!found) return null;
  const headers: Record<string, string> = {};
  if (found.retryAfter !== null) headers["Retry-After"] = String(found.retryAfter);
  return Response.json(found.body, { status: found.status, headers });
}
