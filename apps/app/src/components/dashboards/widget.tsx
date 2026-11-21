import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { WorldMap } from "../world-map";
import { ChartAudience } from "@/lib/chart-audience";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { groupLabel, number, type EventRow, type Group, type Product } from "@/lib/api";
import {
  cellKind,
  formatCell,
  parseJsonCell,
  comparesPreviousPeriod,
  formatMeasure,
  lowerIsBetter,
  hasSeriesLabel,
  resolvedSize,
  responsiveWidth,
  seriesDisplayLabel,
  TABLE_ROW_LIMIT,
  tableColumns,
  tableNotes,
  validTime,
  thresholdColor,
  type CellKind,
  type QuerySpec,
  type RunResult,
  type SeriesResult,
  type Unit,
  type View,
  type Widget,
} from "@/lib/dashboards";
import { DAY_MS } from "@/lib/date-range";
import { growth } from "@/lib/growth";
import { displayTimestamp } from "@/lib/display-time";
import { displayValue } from "@/lib/display-values";
import type { LogRow } from "@/lib/logs";
import { TypedValue } from "@/lib/highlight";
import { Markdown } from "@/lib/markdown";
import { bucketLabels, type TimeBucket } from "@/lib/time-buckets";
import { useNearViewport, useWidgetRun } from "@/lib/use-widget";
import { eventsLink, logsLink } from "@/lib/widget-links";
import { useWorkspace } from "../app-shell";
import { useDisplayPreferences } from "../display-preferences";
import { GrowthLine, OverviewWidget, WidgetContent, WidgetValue } from "../overview-widgets";
import { ChartLegend, chartSeries, colorVar, WidgetChart } from "./widget-chart";
import { useOrganizationSlug } from "@/lib/workspace-route";

type Props = {
  widget: Widget;
  product: Product;
  /** Log retention, for the "Logs kept N days" note on widgets that read logs. */
  logRetentionDays?: number;
  /** Reports whether this widget is loading or refreshing while in view. */
  onPendingChange?: (id: string, pending: boolean) => void;
};

/**
 * One dashboard widget in the Overview widget card: title, description as a hint, a body per
 * view, and a footer for its range, clamping and retention notes, or its error with Retry.
 */
export function WidgetView(props: Props) {
  return props.widget.view.type === "text" ? (
    <TextWidget widget={props.widget} />
  ) : (
    <QueryWidget {...props} />
  );
}

/** Grid placement: the written size and the medium and narrow widths it maps to (spec §5). */
function placement(widget: Widget) {
  const { w, h } = resolvedSize(widget);
  return {
    "data-widget": widget.id,
    "data-view": widget.view.type,
    "data-w": w,
    "data-h": h,
    style: {
      "--widget-span-wide": responsiveWidth(w, "wide"),
      "--widget-span-medium": responsiveWidth(w, "medium"),
      "--widget-span-narrow": responsiveWidth(w, "narrow"),
      "--widget-rows": h,
    } as CSSProperties,
  };
}

function Hint({ widget }: { widget: Widget }) {
  if (!widget.description) return null;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        className="widget-hint"
        aria-label={`About ${widget.title}`}
      >
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="top" className="widget-hint-content">
        {widget.description}
      </PopoverContent>
    </Popover>
  );
}

function TextWidget({ widget }: { widget: Widget }) {
  return (
    <OverviewWidget
      {...placement(widget)}
      title={widget.title}
      className="dashboard-widget"
      controls={<Hint widget={widget} />}
      retry={() => {}}
    >
      <div className="dashboard-markdown">
        <Markdown source={widget.view.markdown ?? ""} />
      </div>
    </OverviewWidget>
  );
}

/**
 * The same object while its JSON is unchanged, so a reloaded document or project list (each live
 * dashboards signal) keeps charts, their keyboard inspection and tooltips in place.
 */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  // The JSON is the value's identity.
  return useMemo(() => value, [key]);
}

function QueryWidget({ widget: given, product, logRetentionDays, onPendingChange }: Props) {
  const orgSlug = useOrganizationSlug();
  const { range, rangeScope, sourceId, refreshKey } = useWorkspace();
  const widget = useStable(given);
  const sources = useStable(product.sources);
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref);
  const run = useWidgetRun(product.id, widget, range, rangeScope, sourceId, refreshKey, near);
  const pending = near && (run.loading || run.refreshing);
  useEffect(() => {
    onPendingChange?.(widget.id, pending);
  }, [widget.id, pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(widget.id, false), [widget.id, onPendingChange]);
  const result = run.data;
  const kind = widget.view.type;
  const query = Object.values(widget.queries)[0];
  const span = result
    ? { from: iso(result.range.from), to: iso(result.range.to) }
    : widgetRange(widget, range);
  const body = (() => {
    const shared = { widget, sources, result, loading: run.loading };
    switch (kind) {
      case "stat":
        return <StatBody {...shared} />;
      case "line":
      case "area":
      case "bar":
        return <ChartBody {...shared} span={span} />;
      case "ranking":
        return <RankingBody {...shared} />;
      case "map": {
        const rows =
          result?.series[0]?.groups?.flatMap((g) =>
            typeof g.label === "string" && typeof g.value === "number"
              ? [{ label: g.label, count: g.value }]
              : [],
          ) ?? [];
        return (
          <div>
            <WorldMap rows={rows} label={widget.title} />
            <details>
              <summary>Country values</summary>
              {rows.map((r) => (
                <div key={r.label}>
                  {r.label} · {number(r.count, 2)}
                </div>
              ))}
            </details>
          </div>
        );
      }
      case "table":
        return <DataTableBody {...shared} />;
      case "events":
        return <EventRowsBody {...shared} />;
      default:
        return <LogRowsBody {...shared} />;
    }
  })();
  // A list opens on its page with the same rows, when that page can show the query.
  const events =
    kind === "events" && query?.signal === "events"
      ? eventsLink(query, span, product, sourceId)
      : undefined;
  const logs =
    kind === "logs" && query?.signal === "logs"
      ? logsLink(query, span, product, sourceId)
      : undefined;
  const link = events ? (
    <Link
      to="/$orgSlug/$projectSlug/events"
      params={{ orgSlug: orgSlug ?? "", projectSlug: product.slug }}
      search={events}
      className="widget-link"
    >
      Open in Events
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden="true" />
    </Link>
  ) : logs ? (
    <Link
      to="/$orgSlug/$projectSlug/logs"
      params={{ orgSlug: orgSlug ?? "", projectSlug: product.slug }}
      search={logs}
      className="widget-link"
    >
      Open in Logs
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden="true" />
    </Link>
  ) : null;
  return (
    <OverviewWidget
      {...placement(widget)}
      ref={ref}
      aria-busy={pending}
      title={widget.title}
      className="dashboard-widget"
      controls={
        <>
          <Hint widget={widget} />
          {link}
        </>
      }
      error={run.error}
      retry={run.retry}
      footer={<WidgetFooter widget={widget} result={result} logRetentionDays={logRetentionDays} />}
    >
      {body}
    </OverviewWidget>
  );
}

type Sources = Product["sources"];
type BodyProps = {
  widget: Widget;
  /** For source names; stable while the project's sources are unchanged. */
  sources: Sources;
  result?: RunResult;
  loading: boolean;
};

const groupByOf = (query?: QuerySpec) =>
  query?.signal === "events" || query?.signal === "logs" ? query.group_by : undefined;

/** A series' own unit wins over the view's. */
function measureView(widget: Widget, index: number): View {
  const unit: Unit | undefined = widget.series?.[index]?.unit ?? widget.view.unit;
  return { ...widget.view, unit };
}

/** Change of the first series against the previous period, coloured by which direction is good. */
function seriesGrowth(widget: Widget, result?: RunResult) {
  const first = result?.series[0];
  const view = measureView(widget, 0);
  return growth(first?.total, first?.previous_total, {
    range: result?.range,
    lowerIsBetter: lowerIsBetter(view),
    points: view.unit === "percent" ? 1 : view.unit === "ratio" ? 100 : undefined,
  });
}

function StatBody({ widget, result, loading }: BodyProps) {
  const first = result?.series[0];
  const definition = widget.series?.[0];
  const view = measureView(widget, 0);
  const value = first?.total ?? null;
  const thresholds = definition?.thresholds ?? [];
  const fallback = first?.color ?? definition?.color ?? "yellow";
  const color = thresholds.length ? thresholdColor(value, thresholds, fallback) : undefined;
  const compare = comparesPreviousPeriod(widget.view);
  // A lone unlabelled series needs no sub-label: the widget title already names it.
  const count = widget.series?.length ?? Object.keys(widget.queries).length;
  const name = hasSeriesLabel(widget, 0) || count > 1 ? (seriesDisplayLabel(widget, 0) ?? "") : "";
  return (
    <div className="dashboard-stat" data-color={color}>
      <WidgetValue
        value={formatMeasure(value, view)}
        label={name}
        growth={compare ? seriesGrowth(widget, result) : undefined}
        compactGrowth
        loading={loading}
      />
      {widget.view.sparkline && <Sparkline points={first?.points} color={fallback} />}
    </div>
  );
}

/** A decorative trend line; the value beside it carries the measurement. */
function Sparkline({
  points,
  color,
}: {
  points?: { time: number; value: number | null }[];
  color: keyof typeof colorVar;
}) {
  const values = (points ?? []).map((point) => point.value);
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length < 2) return <span className="dashboard-sparkline" aria-hidden="true" />;
  const max = Math.max(...finite);
  const min = Math.min(0, ...finite);
  const span = max - min || 1;
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      open = false;
      return;
    }
    const x = values.length > 1 ? (index / (values.length - 1)) * 100 : 0;
    const y = 30 - ((value - min) / span) * 28;
    path += `${open ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    open = true;
  });
  return (
    <svg
      className="dashboard-sparkline"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} style={{ stroke: colorVar[color] }} />
    </svg>
  );
}

function ChartBody({
  widget,
  sources,
  result,
  loading,
  span,
}: BodyProps & { span: { from: string; to: string } }) {
  const groupBy = groupByOf(Object.values(widget.queries)[0]);
  // Stable inputs keep the chart definition (and its focus and tooltip) across parent renders:
  // a refresh that returns the same series keeps them too.
  const results = result?.series;
  const series = useMemo(
    () =>
      results
        ? chartSeries(results, widget.series, (s, index) =>
            seriesLabel(widget, s, index, groupBy, sources),
          )
        : [],
    [results, widget, groupBy, sources],
  );
  const view = useMemo(() => measureView(widget, 0), [widget]);
  const hasValues = series.some((s) => [...s.points.values()].some((value) => value !== null));
  const compare = comparesPreviousPeriod(widget.view) && !!result?.series[0]?.previous_points;
  const comparing = comparesPreviousPeriod(widget.view);
  const bucket = (result?.range.bucket ?? "day") as TimeBucket;
  return (
    <div className="dashboard-chart">
      <div className="dashboard-chart-head">
        <ChartLegend
          series={series}
          view={view}
          previous={
            compare && series.length ? (result?.series[0]?.previous_total ?? null) : undefined
          }
        />
        {comparing && <GrowthLine growth={seriesGrowth(widget, result)} loading={loading} />}
      </div>
      <div className="widget-plot chart-plot" aria-busy={loading}>
        <WidgetContent
          label="chart"
          loading={loading}
          empty={
            !result ? "Chart unavailable." : !hasValues ? "No values in this range." : undefined
          }
        >
          {result && (
            <ChartAudience
              value={Object.values(widget.queries).flatMap((q) =>
                q.signal === "events"
                  ? [
                      {
                        event: q.event,
                        identity_kind: q.identity_kind,
                        source_id: q.source_id,
                        filters: q.filters,
                      },
                    ]
                  : [],
              )}
            >
              <WidgetChart
                result={result}
                view={view}
                bucket={bucket}
                range={span}
                series={series}
                label={widget.title}
                zoom={!widget.range}
              />
            </ChartAudience>
          )}
        </WidgetContent>
      </div>
    </div>
  );
}

function RankingBody({ widget, sources, result, loading }: BodyProps) {
  const groupBy = groupByOf(Object.values(widget.queries)[0]);
  const first = result?.series[0];
  const rows = first?.groups ?? [];
  const thresholds = widget.series?.[0]?.thresholds ?? [];
  const max = Math.max(0, ...rows.map((row) => row.value ?? 0)) || 1;
  // The first series draws the bar; every series is a value column, aligned by group label.
  const columns = (result?.series ?? []).map((series, index) => ({
    key: `series:${index}`,
    label: seriesDisplayLabel(widget, index) ?? series.label,
    view: measureView(widget, index),
    values: new Map(
      (series.groups ?? []).map((group) => [JSON.stringify(group.label), group.value]),
    ),
  }));
  return (
    <WidgetContent
      label={widget.title}
      loading={loading}
      empty={
        !result ? "Ranking unavailable." : rows.length ? undefined : "No values in this range."
      }
    >
      <section className="widget-ranking dashboard-ranking" aria-label={widget.title}>
        <div className="breakdown-head">
          <span>{dimensionLabel(groupBy)}</span>
          <span className="dashboard-columns">
            {columns.map((column) => (
              <span key={column.key}>{column.label}</span>
            ))}
          </span>
        </div>
        {rows.map((row) => {
          const key = JSON.stringify(row.label);
          const label = groupText(groupBy, row.label, sources);
          return (
            <div
              className="breakdown-row"
              key={key}
              data-color={
                first && thresholds.length
                  ? thresholdColor(row.value, thresholds, first.color)
                  : undefined
              }
            >
              <div
                className="breakdown-fill"
                style={{
                  // As in Overview's reports, bars stop short of the values; extra columns
                  // take their own room first.
                  width: `calc((100% - ${(columns.length - 1) * 72}px) * ${Math.max(0, (row.value ?? 0) / max) * 0.85})`,
                }}
              />
              <span className="breakdown-label" title={label}>
                {label}
              </span>
              <span className="breakdown-values dashboard-columns">
                {columns.map((column) => (
                  <span className="breakdown-value" key={column.key}>
                    {formatMeasure(column.values.get(key) ?? null, column.view)}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </section>
    </WidgetContent>
  );
}

/** "13 Nov, 15:03:37" in the Settings timezone (narrow screens drop the date); full in the title. */
function RowTime({ timestamp }: { timestamp: number }) {
  const { timeZone } = useDisplayPreferences();
  const full = displayTimestamp(timestamp, timeZone);
  const [date, time] = full.split(", ");
  return (
    <time dateTime={new Date(timestamp).toISOString()} title={full}>
      <span className="dashboard-row-date">{date.replace(/ \d{4}$/, "")}, </span>
      {time.slice(0, -4)}
    </time>
  );
}

/** A table: the result's own columns under a sticky header, scrolling inside the widget. */
function DataTableBody({ widget, result, loading }: BodyProps) {
  const { timeZone } = useDisplayPreferences();
  const columns = tableColumns(result?.columns);
  const kinds = columns.map((column) => cellKind(column.type));
  const rows = ((result?.rows ?? []) as unknown[][]).slice(0, TABLE_ROW_LIMIT);
  return (
    <WidgetContent
      label={widget.title}
      loading={loading}
      empty={
        !result
          ? "Results unavailable."
          : !columns.length
            ? "The query returned no columns."
            : rows.length
              ? undefined
              : "The query returned no rows."
      }
    >
      <section
        className="dashboard-table"
        // A scrolling region has to be reachable without a pointer.
        // Allow keyboard scrolling of the table.
        tabIndex={0}
        aria-label={widget.title}
      >
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => (
                <TableHead
                  key={index}
                  data-kind={kinds[index]}
                  title={`${column.name} (${column.type})`}
                  scope="col"
                >
                  {column.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {kinds.map((kind, index) => (
                  <TableCell
                    key={index}
                    data-kind={kind}
                    title={
                      typeof row[index] === "string" && kind !== "json" ? row[index] : undefined
                    }
                  >
                    <CellValue
                      value={row[index]}
                      kind={kind}
                      column={columns[index].name}
                      unit={columns[index].unit}
                      timeZone={timeZone}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </WidgetContent>
  );
}

function CellValue({
  value,
  kind,
  column,
  unit,
  timeZone,
}: {
  value: unknown;
  kind: CellKind;
  column: string;
  unit?: Unit;
  timeZone: string;
}) {
  if (value === null || value === undefined) return <span className="dashboard-cell-null">—</span>;
  if (unit && kind === "number" && typeof value === "number")
    return <>{formatMeasure(value, { unit })}</>;
  const time = kind === "timestamp" ? validTime(value) : null;
  if (time !== null) {
    const full = displayTimestamp(time, timeZone);
    return (
      <time dateTime={new Date(time).toISOString()} title={full}>
        {full}
      </time>
    );
  }
  if (kind === "json") {
    const parsed = parseJsonCell(value);
    if (parsed !== null && typeof parsed === "object") return <TypedValue value={parsed} />;
  }
  return <>{formatCell(value, kind, column)}</>;
}

function EventRowsBody({ widget, sources, result, loading }: BodyProps) {
  const rows = (result?.rows ?? []) as unknown as EventRow[];
  return (
    <WidgetContent
      label={widget.title}
      loading={loading}
      empty={
        !result
          ? "Events unavailable."
          : rows.length
            ? undefined
            : "No matching events in this range."
      }
    >
      <section
        className="widget-ranking dashboard-rows"
        data-rows="events"
        aria-label={widget.title}
      >
        <div className="breakdown-head dashboard-row">
          <span>Time</span>
          <span>Event</span>
          <span>Source</span>
        </div>
        <ul>
          {rows.map((row) => {
            return (
              <li className="dashboard-row" key={row.event_id}>
                <RowTime timestamp={row.timestamp} />
                <span className="dashboard-row-main" title={row.name}>
                  {row.name}
                </span>
                <span className="dashboard-row-meta">
                  {sources.find((source) => source.id === row.source_id)?.name ?? row.source}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </WidgetContent>
  );
}

function LogRowsBody({ widget, result, loading }: BodyProps) {
  const rows = (result?.rows ?? []) as unknown as LogRow[];
  return (
    <WidgetContent
      label={widget.title}
      loading={loading}
      empty={
        !result ? "Logs unavailable." : rows.length ? undefined : "No matching logs in this range."
      }
    >
      <section className="widget-ranking dashboard-rows" data-rows="logs" aria-label={widget.title}>
        <div className="breakdown-head dashboard-row">
          <span>Time</span>
          <span>Level</span>
          <span>Service</span>
          <span>Message</span>
        </div>
        <ul>
          {rows.map((row) => {
            return (
              <li className="dashboard-row" key={row.log_id}>
                <RowTime timestamp={row.timestamp} />
                <span className="log-level" data-level={row.level}>
                  {row.level}
                </span>
                <span className="dashboard-row-meta" title={row.service}>
                  {row.service}
                </span>
                <span className="dashboard-row-main" title={row.message}>
                  {row.message}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </WidgetContent>
  );
}

function WidgetFooter({
  widget,
  result,
  logRetentionDays,
}: {
  widget: Widget;
  result?: RunResult;
  logRetentionDays?: number;
}) {
  const notes: string[] = [];
  const range = result?.range;
  if (range?.clamped) {
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS);
    notes.push(
      result?.warnings.find((warning) => warning.path === "/range")?.message ??
        `Newest ${days} days`,
    );
  } else if (widget.range) notes.push(overrideLabel(widget.range));
  if (range && ["line", "area", "bar"].includes(widget.view.type))
    notes.push(`${bucketLabels[range.bucket as TimeBucket] ?? range.bucket} · UTC`);
  if (widget.view.type === "table" && result?.rows)
    notes.push(...tableNotes(result.rows.length, result.warnings));
  const readsLogs = Object.values(widget.queries).some((query) => query.signal === "logs");
  if (
    readsLogs &&
    range &&
    logRetentionDays &&
    Date.parse(range.from) < Date.parse(range.to) - logRetentionDays * DAY_MS
  )
    notes.push(`Logs kept ${logRetentionDays} days`);
  return (
    <span
      className="dashboard-footer-notes"
      title={result ? `Ran in ${number(result.elapsed_ms)} ms` : undefined}
    >
      {notes.join(" · ")}
    </span>
  );
}

/** "24h" reads "Last 24 hours", "1d" reads "Last day". */
function overrideLabel(range: string) {
  const amount = Number(range.slice(0, -1));
  const unit = range.endsWith("h") ? "hour" : "day";
  return amount === 1 ? `Last ${unit}` : `Last ${amount} ${unit}s`;
}

const iso = (value: string) => new Date(value).toISOString();

/** The widget's own window before its first result: its range override, or the workspace's. */
function widgetRange(widget: Widget, range: { from: string; to: string }) {
  if (!widget.range) return range;
  const hours = Number(widget.range.slice(0, -1)) * (widget.range.endsWith("d") ? 24 : 1);
  return { from: new Date(Date.parse(range.to) - hours * 3_600_000).toISOString(), to: range.to };
}

const dimensions: Record<string, string> = {
  name: "Event",
  source_id: "Source",
  source: "Client",
  identity_kind: "Identity kind",
  level: "Level",
  service: "Service",
  environment: "Environment",
};
function dimensionLabel(groupBy?: string) {
  if (!groupBy) return "Group";
  return dimensions[groupBy] ?? groupBy.replace(/^(property|attribute):/, "");
}

/** Group labels read like Overview's reports: source names, display names, "Not provided". */
function groupText(groupBy: string | undefined, label: unknown, sources: Sources) {
  if (groupBy === "source_id" && typeof label === "string")
    return sources.find((source) => source.id === label)?.name ?? "Unknown source";
  if (label === null || label === undefined || label === "") return groupLabel(label as null);
  if (groupBy?.startsWith("property:") && typeof label !== "object")
    return displayValue(groupBy, label);
  return groupLabel(label as Group["label"]);
}

/** Grouped series are named by their group; the rest by their display label. */
function seriesLabel(
  widget: Widget,
  series: SeriesResult,
  index: number,
  groupBy: string | undefined,
  sources: Sources,
) {
  if (series.group !== undefined) return groupText(groupBy, series.group, sources);
  return seriesDisplayLabel(widget, index) ?? series.label;
}
