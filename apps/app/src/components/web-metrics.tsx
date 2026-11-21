import { Link } from "@tanstack/react-router";
import { number, queryReadOnly } from "@/lib/api";
import { growth } from "@/lib/growth";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { useReportQuery } from "@/lib/use-query";
import { automaticBucket, partialBucketNote } from "@/lib/time-buckets";
import { webMetricLabels, type WebMetric } from "@/lib/web-metrics";
import type { webMetrics } from "@/server/queries/web-metrics";
import { useWorkspace } from "./app-shell";
import { OverviewWidget, WidgetContent, WidgetValue } from "./overview-widgets";
import { AnalyticsChart } from "./analytics-chart";
import { ValueSelect } from "./value-select";

const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof webMetrics>>>(
    `/products/${id}/web-metrics`,
    body,
    signal,
  );
export function useWebMetrics(enabled: boolean, filters: Record<string, unknown>) {
  const { product, sourceId, range, rangeScope, refreshKey } = useWorkspace();
  return useReportQuery(
    load,
    "web-metrics",
    enabled ? product?.id : undefined,
    { ...range, source_id: sourceId, bucket: automaticBucket(range), ...filters },
    refreshKey,
    `${rangeScope}:${sourceId}:${JSON.stringify(filters)}`,
  );
}
type Data = ReturnType<typeof useWebMetrics>;
const metrics = Object.keys(webMetricLabels) as WebMetric[];
const text = (metric: WebMetric, value: string | number | null | undefined) =>
  value == null
    ? "—"
    : metric === "revenue"
      ? `${BigInt(value).toLocaleString("en-US")} ¢`
      : `${number(Number(value), 1)}${metric === "bounce_rate" ? "%" : metric === "session_duration" ? " s" : ""}`;
function difference(metric: WebMetric, result: Data, range: { from: string; to: string }) {
  const now = result.data?.current[metric],
    before = result.data?.previous[metric];
  return growth(now == null ? null : Number(now), before == null ? null : Number(before), {
    range,
    lowerIsBetter: metric === "bounce_rate",
    points: metric === "bounce_rate" ? 1 : undefined,
  });
}
const descriptions: Record<WebMetric, string> = {
  visitors: "Unique visitor IDs",
  sessions: "Visits started",
  page_views: "All page views",
  pages_per_session: "Mean per visit",
  bounce_rate: "Single-page visits",
  session_duration: "Mean visit length",
  revenue: "Net integer cents",
};
const needsIdentity = (m: WebMetric) => m !== "page_views" && m !== "revenue";
export function WebTiles({
  result,
  selected,
  select,
}: {
  result: Data;
  selected: WebMetric;
  select: (m: WebMetric) => void;
}) {
  const { source, range, product } = useWorkspace(),
    target = useWorkspaceTarget();
  return (
    <section className="overview-metrics" aria-label="Website metrics">
      {metrics.map((metric) => (
        <article className="metric-widget" key={metric}>
          <button
            className="metric-label text-left hover:underline"
            aria-pressed={selected === metric}
            onClick={() => select(metric)}
          >
            {webMetricLabels[metric]}
          </button>
          {source?.visitor_mode === "off" && needsIdentity(metric) ? (
            <p className="text-xs">
              Visitor counting is off for this source.{" "}
              <Link {...target("/settings", product?.slug)} className="text-primary underline">
                Source settings
              </Link>
            </p>
          ) : (
            <WidgetValue
              value={text(metric, result.data?.current[metric])}
              label={descriptions[metric]}
              growth={difference(metric, result, range)}
              loading={result.loading}
              compactGrowth
            />
          )}
        </article>
      ))}
    </section>
  );
}
export function WebChart({
  result,
  selected,
  select,
}: {
  result: Data;
  selected: WebMetric;
  select: (m: WebMetric) => void;
}) {
  const { range, refresh, source } = useWorkspace(),
    bucket = automaticBucket(range),
    off = source?.visitor_mode === "off" && needsIdentity(selected);
  const series =
    result.data?.series.map((row) => ({
      time: row.time,
      value: row[selected] === null ? null : Number(row[selected]),
      exact: selected === "revenue" ? row.revenue : undefined,
    })) ?? [];
  return (
    <OverviewWidget
      title="Activity over time"
      className="activity-widget"
      error={result.error}
      retry={refresh}
      footer={
        <span className="chart-period-note">
          One point per {bucket} · UTC · {partialBucketNote(range, bucket)}
        </span>
      }
    >
      <div className="widget-value-row">
        <WidgetValue
          value={off ? "—" : text(selected, result.data?.current[selected])}
          label={webMetricLabels[selected]}
          growth={off ? undefined : difference(selected, result, range)}
          loading={result.loading}
        />
        <ValueSelect
          label="Chart metric"
          value={selected}
          onValueChange={(v) => select(v as WebMetric)}
          options={metrics.map((m) => [m, webMetricLabels[m]])}
        />
      </div>
      <div className="widget-plot chart-plot">
        <WidgetContent
          label="chart"
          loading={result.loading}
          empty={
            off
              ? "Visitor counting is off for this source."
              : series.every((r) => r.value === null)
                ? "No matching observations."
                : undefined
          }
        >
          <AnalyticsChart
            series={series}
            label={webMetricLabels[selected]}
            range={range}
            bucket={bucket}
            bars={selected === "revenue"}
            unit={
              selected === "revenue"
                ? "¢"
                : selected === "bounce_rate"
                  ? "%"
                  : selected === "session_duration"
                    ? "s"
                    : undefined
            }
          />
        </WidgetContent>
      </div>
    </OverviewWidget>
  );
}
