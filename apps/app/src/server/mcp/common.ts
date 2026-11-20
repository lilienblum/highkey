// What every MCP tool shares: a tool's handler type, turning thrown errors into readable tool
// errors, and the lookups that answer a miss with the nearest slugs. A failing tool returns the
// HTTP error body as a tool result marked as an error, so an agent can read the JSON paths and
// hints and fix its call; JSON-RPC errors are only for unknown tools and protocol faults.
import { requireActor } from "../auth/actor";
import type { ApiContext } from "../api/context";
import { ApiError } from "../api/errors";
import { DashboardError, detailed, notFound, parts } from "../dashboards/errors";
import { missingHint } from "../dashboards/suggest";
import type { Issue } from "../dashboards/validate";
import { products, resolveProduct } from "../db/products";
import { listSources, resolveSource } from "../db/sources";

// biome-ignore lint/suspicious/noExplicitAny: tool arguments are checked against their schema.
export type Args = Record<string, any>;
export type Tool = (ctx: ApiContext, args: Args) => Promise<unknown>;

/** A 400 about one argument, at its JSON Pointer (`/base_revision`), with a hint. */
export function badArgument(path: string, message: string, hint: string): DashboardError {
  return detailed(400, "Invalid argument", "invalid_argument", [{ path, message, hint }]);
}

/** A confirmation that does not equal the `field` (slug or id) of what `action` would affect. */
export function confirmMismatch(
  action: string,
  what: string,
  field: string,
  value: string,
): DashboardError {
  return detailed(400, "Confirmation does not match", "confirm_mismatch", [
    {
      path: "/confirm",
      message: `\`confirm\` must equal the ${what}'s ${field}, \`${value}\``,
      hint: `Pass confirm: "${value}" to ${action} this ${what}; it cannot be undone`,
    },
  ]);
}

/** The argument a validation message is about, and how to fix it. */
function fieldHint(message: string): [string, string] | null {
  if (message.includes("source icon"))
    return [
      "/icon",
      "Use one of: website, ios, android, mobile, terminal, desktop, server, code, package, game, generic. Omit icon to pick one automatically",
    ];
  if (message.includes("source name")) return ["/name", "Use 1–80 bytes"];
  if (message.includes("source with that name"))
    return [
      "/name",
      "Names are unique per project, ignoring case; pick another or call list_sources",
    ];
  if (message.includes("project name")) return ["/name", "Use 1–80 bytes"];
  if (message.includes("retention_days"))
    return ["/retention_days", "Use a whole number of days from 1 to 3650"];
  if (message.includes("Log retention"))
    return ["/retention_days", "Use a whole number of days from 1 to 365"];
  if (message.includes("label")) return ["/label", "Use 1–80 bytes"];
  if (message.includes("origin"))
    return [
      "/allowed_origins",
      "Use at most 16 origins such as https://example.com or https://*.example.com, each without a path, query or credentials",
    ];
  if (message.includes("website"))
    return [
      "/website_url",
      'Use an HTTP(S) address such as https://example.com; pass "" to clear it',
    ];
  return null;
}

const CODES: Record<number, string> = {
  400: "invalid_input",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  503: "busy",
};

/** The tool error body for anything a tool threw, with `retry_after_secs` where HTTP sends Retry-After. */
export function errorBody(error: unknown): Record<string, unknown> {
  const known = parts(error);
  if (known) {
    const body = { ...known.body };
    if (known.retryAfter !== null) body.retry_after_secs = known.retryAfter;
    return body;
  }
  if (error instanceof ApiError) {
    const found = fieldHint(error.message);
    const errors: Issue[] = found
      ? [{ path: found[0], message: error.message, hint: found[1] }]
      : [];
    return { error: error.message, code: CODES[error.status] ?? "internal", errors };
  }
  console.error("MCP tool failed", error);
  return { error: "Internal error", code: "internal", errors: [] };
}

/** A 404 from `work` becomes a `not_found` for `what`, with a hint. */
export async function orMissing<T>(what: string, hint: string, work: () => Promise<T> | T) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw notFound(what, hint);
    throw error;
  }
}

/** The id of the project named by id or slug. A miss names the nearest slugs. */
export async function projectId(ctx: ApiContext, key: string): Promise<string> {
  try {
    return (await resolveProduct(ctx.db, key, requireActor(ctx).orgId)).id;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const slugs = (await products(ctx.db, requireActor(ctx).orgId)).map((p) => p.slug);
    throw notFound("Project", missingHint(key, slugs, "projects"));
  }
}

/** The id of a project's source named by id or slug. A miss names the nearest slugs. */
export async function sourceId(ctx: ApiContext, project: string, key: string): Promise<string> {
  try {
    return (await resolveSource(ctx.db, project, key)).id;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const slugs = (await listSources(ctx.db, project)).map((s) => s.slug);
    throw notFound("Source", missingHint(key, slugs, "sources"));
  }
}

export { DashboardError };
