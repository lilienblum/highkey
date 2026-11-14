import type { Product } from "./api";
import type { EventsQuery, LogsQuery } from "./dashboards";
import { DAY_MS } from "./date-range";
import type { ExploreSearch } from "./explore-search";
import { clearedLogs, type LogsSearch } from "./logs";
import { explorable, logsRunnable, queryToLogs, queryToSpec, type LogViewQuery } from "./views";
import { sourceParam, type WorkspaceSearch } from "./workspace-search";

type Span = { from: string; to: string };
type Sources = Pick<Product, "sources">;
/** Logs reads at most 31 days at once. */
const LOGS_SPAN_MS = 31 * DAY_MS;

/**
 * Events narrowed by everything the widget's query narrows by (its event, every filter, a pinned
 * identity kind or source) over the widget's window, under the dashboard's own source. Undefined
 * when Events cannot show that query, so no link offers a different one.
 */
export function eventsLink(
  query: EventsQuery,
  span: Span,
  product: Sources,
  sourceId?: string,
): (ExploreSearch & WorkspaceSearch) | undefined {
  const { signal: _signal, ...rest } = query;
  const spec = queryToSpec({ ...rest, measure: rest.measure ?? "count" });
  if (!explorable(spec)) return;
  return {
    source: sourceParam(product.sources, sourceId),
    period: undefined,
    snapshot: undefined,
    from: span.from,
    to: span.to,
    drilldown: undefined,
    view: undefined,
    viewAt: undefined,
    page: undefined,
    query: spec,
  };
}

/**
 * Logs with every filter the widget's query uses (severity floor, service, environment, search,
 * attributes, a pinned source) over the widget's window, at most its newest 31 days. Undefined
 * when Logs cannot express that query (an attribute that must be missing, say).
 */
export function logsLink(
  query: LogsQuery,
  span: Span,
  product: Sources,
  sourceId?: string,
): (LogsSearch & WorkspaceSearch) | undefined {
  if (query.filters?.some((filter) => filter.value === null)) return;
  const filters = query.filters as LogViewQuery["filters"];
  const to = Date.parse(span.to);
  const from = Math.max(Date.parse(span.from), to - LOGS_SPAN_MS);
  const search: LogsSearch = {
    ...clearedLogs,
    ...queryToLogs({
      level: query.level,
      min_level: query.min_level,
      service: query.service,
      environment: query.environment,
      source_id: query.source_id,
      search: query.search,
      filters,
    }),
    logWindow: undefined,
    logFrom: new Date(from).toISOString(),
    logTo: new Date(to).toISOString(),
  };
  if (!logsRunnable(search)) return;
  return { source: sourceParam(product.sources, sourceId), ...search };
}
