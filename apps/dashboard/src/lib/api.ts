import type { SourceIconId } from "./source-icons";

export type Source = {
  id: string;
  product_id: string;
  name: string;
  /** Unique within the project; workspace URLs name the source by it. */
  slug: string;
  icon: SourceIconId | null;
  created_at: string;
};
export type DashboardLink = { id: string; slug: string; name: string };
/** A saved view in the sidebar: an event view sits under Events, a log view under Logs. */
export type ViewLink = { id: string; slug: string; name: string; kind: "events" | "logs" };
export type Product = {
  slug: string;
  website_url: string | null;
  favicon_version: string | null;
  id: string;
  name: string;
  sources: Source[];
  /** Named dashboards, ordered by name; absent when an older API or a mock omits them. */
  dashboards?: DashboardLink[];
  /** Saved views, ordered by name; absent when an older API or a mock omits them. */
  views?: ViewLink[];
  retention_days: number;
  created_at: string;
};
export type Properties = Record<string, string | number | boolean>;
export type EventRow = {
  event_id: string;
  name: string;
  source: string;
  source_id: string;
  timestamp: number;
  received_at: number;
  actor_id: string | null;
  identity_kind: string | null;
  session_id: string | null;
  properties: Properties;
};
export type Group = {
  display?: string;
  label: string | number | boolean | null;
  value: number | null;
  count: number;
};
export type QueryResult = {
  summary: {
    total: number;
    actors: number;
    visitors: number;
    installations: number;
    sessions: number;
    session_views: number;
    success_rate: number | null;
    avg_duration: number | null;
    p95_duration: number | null;
    value: number | null;
  };
  series: { time: number; value: number | null }[];
  groups: Group[];
  events: EventRow[];
  event_names: string[];
  page: number;
  page_size: number;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
    /** The parsed JSON error body, when the response had one. */
    public payload?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      "content-type": "application/json",
      "x-highkey-origin": "dashboard",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const seconds = Number(response.headers.get("retry-after") ?? NaN);
    throw new ApiError(
      payload.error ?? `Request failed (${response.status})`,
      response.status,
      Number.isFinite(seconds) && seconds >= 0 && seconds <= 5 ? seconds * 1000 : undefined,
      payload && typeof payload === "object" ? payload : undefined,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
// Read-only queries retry one short server-requested capacity delay; mutations never do.
// `busyMessage` replaces a capacity (503) error's text for callers that want a generic message.
export async function queryReadOnly<T>(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  busyMessage?: string,
) {
  const request = async () => {
    try {
      return await api<T>(
        path,
        "POST",
        body,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
    } catch (error) {
      if (busyMessage && error instanceof ApiError && error.status === 503)
        error.message = busyMessage;
      throw error;
    }
  };
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503 || error.retryAfterMs === undefined)
      throw error;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, error.retryAfterMs);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
    return request();
  }
}
export function queryProduct(product: string, body: Record<string, unknown>, signal: AbortSignal) {
  return queryReadOnly<QueryResult>(`/products/${product}/query`, body, signal);
}

export const number = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
export function groupLabel(value: Group["label"]) {
  return value === null ? "Not provided" : value === "" ? "Empty string" : String(value);
}

export function sourceGroups(groups: Group[], sources: Source[] = []): Group[] {
  return groups.map((group) => ({
    ...group,
    display: sources.find((source) => source.id === group.label)?.name ?? "Unknown source",
  }));
}
