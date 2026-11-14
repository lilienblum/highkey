import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
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
  type EventsQuery,
  type LogsQuery,
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
import { defaultSpec } from "@/lib/explore-search";
import { logLevels, type LogRow } from "@/lib/logs";
import { TypedValue } from "@/lib/highlight";
import { Markdown } from "@/lib/markdown";
import { bucketLabels, type TimeBucket } from "@/lib/time-buckets";
import { useNearViewport, useWidgetRun } from "@/lib/use-widget";
import { sourceParam, validKey } from "@/lib/workspace-search";
import { useWorkspace } from "../app-shell";
import { useDisplayPreferences } from "../display-preferences";
import { GrowthLine, OverviewWidget, WidgetContent, WidgetValue } from "../overview-widgets";
import { ChartLegend, chartSeries, colorVar, WidgetChart } from "./widget-chart";

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

function QueryWidget({ widget, product, logRetentionDays, onPendingChange }: Props) {
  const { range, sourceId, refreshKey } = useWorkspace();
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref);
  const run = useWidgetRun(product.id, widget, range, sourceId, refreshKey, near);
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
    const shared = { widget, product, result, loading: run.loading };
    switch (kind) {
      case "stat":
        return <StatBody {...shared} />;
      case "line":
      case "area":
      case "bar":
        return <ChartBody {...shared} span={span} />;
      case "ranking":
        return <RankingBody {...shared} />;
      case "table":
        return <SqlTableBody {...shared} />;
      case "events":
        return <EventRowsBody {...shared} />;
      default:
        return <LogRowsBody {...shared} />;
    }
  })();
  const link =
    kind === "events" && query?.signal === "events" ? (
      <Link
        to="/projects/$projectSlug/explore"
        params={{ projectSlug: product.slug }}
        search={exploreSearch(query, span, product, sourceId)}
        className="widget-link"
      >
        Open in Explore
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden="true" />
      </Link>
    ) : kind === "logs" && query?.signal === "logs" ? (
      <Link
        to="/projects/$projectSlug/logs"
        params={{ projectSlug: product.slug }}
        search={logsSearch(query, span, product, sourceId)}
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

type BodyProps = {
  widget: Widget;
  product: Product;
  result?: RunResult;
  loading: boolean;
};

const groupByOf = (query?: QuerySpec) =>
  query && query.signal !== "sql" ? query.group_by : undefined;

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
  product,
  result,
  loading,
  span,
}: BodyProps & { span: { from: string; to: string } }) {
  const groupBy = groupByOf(Object.values(widget.queries)[0]);
  // Stable inputs keep the chart definition (and its focus and tooltip) across parent renders.
  const series = useMemo(
    () =>
      result
        ? chartSeries(result, widget.series, (s, index) =>
            seriesLabel(widget, s, index, groupBy, product),
          )
        : [],
    [result, widget, groupBy, product],
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
            <WidgetChart
              result={result}
              view={view}
              bucket={bucket}
              range={span}
              series={series}
              label={widget.title}
              zoom={!widget.range}
            />
          )}
        </WidgetContent>
      </div>
    </div>
  );
}

function RankingBody({ widget, product, result, loading }: BodyProps) {
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
          const label = groupText(groupBy, row.label, product);
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

/** An SQL table: the result's own columns under a sticky header, scrolling inside the widget. */
function SqlTableBody({ widget, result, loading }: BodyProps) {
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
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling of the table
        tabIndex={0}
        aria-label={widget.title}
      >
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => (
                <TableHead
                  // biome-ignore lint/suspicious/noArrayIndexKey: result columns may repeat a name
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
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no identity
              <TableRow key={rowIndex}>
                {kinds.map((kind, index) => (
                  <TableCell
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
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
  timeZone,
}: {
  value: unknown;
  kind: CellKind;
  column: string;
  timeZone: string;
}) {
  if (value === null || value === undefined) return <span className="dashboard-cell-null">—</span>;
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

function EventRowsBody({ widget, product, result, loading }: BodyProps) {
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
                  {product.sources.find((source) => source.id === row.source_id)?.name ??
                    row.source}
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
function groupText(groupBy: string | undefined, label: unknown, product: Product) {
  if (groupBy === "source_id" && typeof label === "string")
    return product.sources.find((source) => source.id === label)?.name ?? "Unknown source";
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
  product: Product,
) {
  if (series.group !== undefined) return groupText(groupBy, series.group, product);
  return seriesDisplayLabel(widget, index) ?? series.label;
}

const exploreOps = ["eq", "ne", "gt", "gte", "lt", "lte"];
/** Explore with the widget's event, its first filter and source, over the widget's window. */
function exploreSearch(
  query: EventsQuery,
  span: { from: string; to: string },
  product: Product,
  sourceId?: string,
) {
  const filter = query.filters?.find(
    (candidate) => validKey(candidate.property) && exploreOps.includes(candidate.op),
  );
  return {
    source: sourceParam(product.sources, query.source_id ?? sourceId),
    period: undefined,
    snapshot: undefined,
    from: span.from,
    to: span.to,
    drilldown: undefined,
    page: undefined,
    query: {
      ...defaultSpec,
      event: query.event && validKey(query.event) ? query.event : "",
      filterProperty: filter?.property ?? "",
      filterOp: filter?.op ?? "eq",
      filterValue: filter ? JSON.stringify(filter.value) : "",
    },
  };
}

/** Logs with the widget's filters it can express, over the widget's (at most 31-day) window. */
function logsSearch(
  query: LogsQuery,
  span: { from: string; to: string },
  product: Product,
  sourceId?: string,
) {
  const filter = query.filters?.find((candidate) => candidate.value !== null);
  const to = Date.parse(span.to);
  const from = Math.max(Date.parse(span.from), to - 31 * DAY_MS);
  const level = logLevels.find((candidate) => candidate === query.level);
  return {
    source: sourceParam(product.sources, query.source_id ?? sourceId),
    logq: query.search,
    level,
    service: query.service,
    environment: query.environment,
    attribute: filter?.attribute,
    attributeValue: filter ? String(filter.value) : undefined,
    attributeType: filter ? (typeof filter.value as "string" | "number" | "boolean") : undefined,
    logWindow: undefined,
    logBefore: undefined,
    logFrom: new Date(from).toISOString(),
    logTo: new Date(to).toISOString(),
  };
}
