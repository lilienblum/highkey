import { displayGroups, displayValue } from "@/lib/display-values";
import { reportLink, sourceWebsite } from "@/lib/report-link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { automaticBucket, partialBucketNote } from "@/lib/time-buckets";
import { useQuery, useReportQuery } from "@/lib/use-query";
import { growth, previousRange, retainedComparison } from "@/lib/growth";
import { DAY_MS } from "@/lib/date-range";
import { OverviewActions } from "./overview-actions";
import { number, sourceGroups, type Group, queryReadOnly } from "@/lib/api";
import type { liveActivity } from "@/server/queries/activity";
import { sourceDistribution } from "@/lib/overview-widgets";
import type { OverviewSearch } from "@/lib/workspace-search";
import type { ExploreDrilldown } from "@/lib/explore-search";
import { useWorkspace, useAnalyticsPending, PageHeader, NoProduct } from "./app-shell";
import { BreakdownRows } from "./shared";
import { AnalyticsChart } from "./analytics-chart";
import { ValueSelect } from "./value-select";
import { ActivityChartKey, OverviewWidget, WidgetContent, WidgetValue } from "./overview-widgets";
import { useOrganizationSlug } from "@/lib/workspace-route";
import { useEventCatalog } from "@/lib/use-event-catalog";
import { eventContext } from "@/lib/event-context";
import { WebsiteReports } from "./website-reports";
import { CohortPicker } from "./cohorts";
import { ChartAudience } from "@/lib/chart-audience";
import { TimelineMarkers } from "./chart-references";
import { BreakdownReport } from "./breakdown-report";
import { useWebMetrics, WebChart, WebTiles } from "./web-metrics";
import { webMetric, type WebMetric } from "@/lib/web-metrics";

type ChartChoice = {
  id: string;
  label: string;
  measure: "count" | "actors" | "avg" | "p95";
  identity_kind?: "visitor" | "installation";
  property?: "duration_ms";
  unit?: "ms";
  /** Shorter is better, so a drop is the good outcome. */
  lowerIsBetter?: boolean;
};
const chartChoices: ChartChoice[] = [
  { id: "count", label: "Events", measure: "count" },
  { id: "actors", label: "Identified actors", measure: "actors" },
  { id: "visitors", label: "Unique visitors", measure: "actors", identity_kind: "visitor" },
  {
    id: "installations",
    label: "Active installations",
    measure: "actors",
    identity_kind: "installation",
  },
  {
    id: "average",
    label: "Average duration",
    measure: "avg",
    property: "duration_ms",
    unit: "ms",
    lowerIsBetter: true,
  },
  {
    id: "p95",
    label: "p95 duration",
    measure: "p95",
    property: "duration_ms",
    unit: "ms",
    lowerIsBetter: true,
  },
];
const dimensions = [
  ["name", "Top events"],
  ["source_id", "Sources"],
  ["source", "Clients"],
  ["property:path", "Pages"],
  ["property:command", "Commands"],
  ["property:referrer", "Referrers"],
  ["property:utm_source", "Campaign sources"],
  ["property:utm_campaign", "Campaigns"],
  ["property:utm_medium", "Campaign mediums"],
  ["property:utm_term", "Campaign terms"],
  ["property:utm_content", "Campaign content"],
  ...Object.entries(eventContext)
    .filter(([k]) => k !== "bot")
    .map(([key, label]) => [`property:context.${key}`, label] as const),
  ["property:screen", "Screens"],
  ["property:version", "Versions"],
  ["property:os", "OS"],
  ["property:arch", "Architecture"],
] as const;

const loadActivity = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof liveActivity>>>(`/products/${id}/activity`, body, signal);

export function Overview() {
  const orgSlug = useOrganizationSlug();
  const { invalidFilter } = useSearch({ strict: false });
  const { product, sourceId } = useWorkspace();
  if (invalidFilter)
    return (
      <>
        <PageHeader
          title="This filter is unavailable"
          description="The link contains an invalid analytics filter."
        />
        <Link
          to="/$orgSlug/$projectSlug"
          params={{ orgSlug: orgSlug ?? "", projectSlug: product?.slug ?? "" }}
          search={(previous) => ({ ...previous, filter: undefined })}
        >
          Clear filter
        </Link>
      </>
    );
  return product ? <ProductOverview key={`${product.id}:${sourceId ?? "all"}`} /> : <NoProduct />;
}
function ProductOverview() {
  const orgSlug = useOrganizationSlug();
  const { product, source, sourceId, range, refresh, refreshKey, now } = useWorkspace();
  const search = useSearch({ strict: false });
  const navigate = useNavigate({ from: "/$orgSlug/$projectSlug/" });
  const dimension = search.breakdown ?? "name";
  const chartMetric = search.metric ?? "count";
  const websiteMetric = webMetric(chartMetric);
  const durationMetric = search.duration ?? "avg";
  const update = (patch: OverviewSearch) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), resetScroll: false });
  const setDimension = (breakdown: string) => update({ breakdown });
  const setChartMetric = (metric: string) => update({ metric: metric as OverviewSearch["metric"] });
  const setDurationMetric = (duration: string) =>
    update({ duration: duration as OverviewSearch["duration"] });
  const selectedFilter = search.filter;
  const eventFilters = {
    event: selectedFilter?.field === "name" ? selectedFilter.value : undefined,
    source: selectedFilter?.field === "source" ? selectedFilter.value : undefined,
    filters: selectedFilter?.field.startsWith("property:")
      ? [{ property: selectedFilter.field.slice(9), op: "eq", value: selectedFilter.value }]
      : [],
  };
  const body = {
    ...range,
    ...eventFilters,
    source_id: sourceId,
    measure: "count",
    group_by: "name",
  };
  const website = useWebMetrics(!!websiteMetric, eventFilters);
  const selectWeb = (m: WebMetric) => setChartMetric(`web_${m}`);
  // Rolling ranges keep one scope while their end time advances; fixed ranges include their end.
  const scope = JSON.stringify([
    range.from,
    search.from || search.snapshot ? range.to : undefined,
    sourceId,
    selectedFilter,
  ]);
  const query = useQuery(product?.id, body, refreshKey, scope);
  const catalog = useEventCatalog(product?.id);
  const conversionNames = catalog.data?.filter((d) => d.conversion).map((d) => d.name) ?? [];
  const conversions = useQuery(
    conversionNames.length ? product?.id : undefined,
    { ...body, names: conversionNames, page_size: 1 },
    refreshKey,
    `${scope}:conversions:${JSON.stringify(conversionNames)}`,
  );
  const canCompareSources = !sourceId && (product?.sources.length ?? 0) > 1;
  const needsSourceQuery = canCompareSources || dimension === "source_id";
  const sources = useQuery(
    needsSourceQuery ? product?.id : undefined,
    { ...body, group_by: "source_id" },
    refreshKey,
    `${scope}:sources`,
  );
  const separateBreakdown = dimension !== "name" && dimension !== "source_id";
  const secondary = useQuery(
    separateBreakdown ? product?.id : undefined,
    { ...body, group_by: dimension },
    refreshKey,
    `${scope}:${dimension}`,
  );
  const breakdown = dimension === "name" ? query : dimension === "source_id" ? sources : secondary;
  const choice = chartChoices.find((option) => option.id === chartMetric) ?? chartChoices[0];
  const bucket = automaticBucket(range);
  const separateChart = choice.id !== "count" || bucket !== "day";
  const chartQuery = useQuery(
    separateChart ? product?.id : undefined,
    {
      ...body,
      measure: choice.measure,
      identity_kind: choice.identity_kind,
      property: choice.property,
      bucket,
      page_size: 1,
    },
    refreshKey,
    `${scope}:${choice.id}:${bucket}`,
  );
  const activity = separateChart ? chartQuery : query;
  // The previous window is the equal span just before the range; its scope keeps navigation instant.
  const before = previousRange(range);
  const previous = useQuery(
    product?.id,
    { ...body, ...before, bucket, align_to_next_period: true, page_size: 1 },
    refreshKey,
    `${scope}:${bucket}:previous`,
  );
  const previousChart = useQuery(
    choice.id !== "count" ? product?.id : undefined,
    {
      ...body,
      ...before,
      bucket,
      align_to_next_period: true,
      measure: choice.measure,
      identity_kind: choice.identity_kind,
      property: choice.property,
      page_size: 1,
    },
    refreshKey,
    `${scope}:${choice.id}:${bucket}:previous`,
  );
  const baseline = choice.id === "count" ? previous : previousChart;
  const comparison = retainedComparison(
    baseline.data?.summary.total ? baseline.data.series : undefined,
    range,
    now - (product?.retention_days ?? 0) * DAY_MS,
  );
  const s = query.data?.summary;
  const p = previous.data?.summary;
  const hasDuration = s?.avg_duration != null;
  const active = useReportQuery(
    loadActivity,
    "live-activity",
    product?.id,
    { to: new Date(now).toISOString(), ...eventFilters, source_id: sourceId },
    refreshKey,
    `active:${sourceId ?? "all"}:${JSON.stringify(selectedFilter)}`,
  );
  useAnalyticsPending(
    query.refreshing ||
      (needsSourceQuery && sources.refreshing) ||
      (separateBreakdown && secondary.refreshing) ||
      (separateChart && chartQuery.refreshing) ||
      previous.refreshing ||
      (choice.id !== "count" && previousChart.refreshing) ||
      active.refreshing ||
      (conversionNames.length > 0 && conversions.refreshing),
  );
  const sourceSlices = useMemo(
    () =>
      sourceDistribution(
        sourceGroups(sources.data?.groups ?? [], product?.sources),
        sources.data?.summary.total ?? 0,
      ),
    [sources.data, product?.sources],
  );
  const showSources = canCompareSources && (!sources.data || sourceSlices.length > 1);
  if (!product) return <NoProduct />;
  const drilldown = (groupBy: string, group: Group): ExploreDrilldown | undefined => {
    if (group.label === null) return;
    const context = { sourceId, ...range };
    if (groupBy === "source_id" && typeof group.label === "string")
      return { ...context, sourceId: group.label };
    if (groupBy === "name" && typeof group.label === "string")
      return { ...context, event: group.label };
    if (groupBy === "source" && typeof group.label === "string")
      return { ...context, source: group.label };
    if (groupBy.startsWith("property:"))
      return { ...context, filter: { property: groupBy.slice(9), value: group.label } };
  };
  const noEvents =
    s?.total === 0
      ? "No events in this range. Try another date range or connect a source in Project settings."
      : undefined;
  const chartEmpty =
    comparison && activity.data
      ? undefined
      : (noEvents ??
        (!activity.data
          ? "Chart unavailable."
          : choice.measure === "actors" && !activity.data.summary.value
            ? `No ${choice.identity_kind === "visitor" ? "visitor" : choice.identity_kind === "installation" ? "installation" : "actor"} IDs received in this range.`
            : choice.unit && activity.data.summary.value === null
              ? "No numeric durations received in this range."
              : undefined));
  const actorGroups: Group[] = [
    { label: "Visitors", value: s?.visitors ?? 0, count: s?.visitors ?? 0 },
    { label: "Installations", value: s?.installations ?? 0, count: s?.installations ?? 0 },
    {
      label: "Other actors",
      value: Math.max(0, (s?.actors ?? 0) - (s?.visitors ?? 0) - (s?.installations ?? 0)),
      count: 0,
    },
  ];
  const dimensionLabel = dimensions.find(([value]) => value === dimension)?.[1] ?? "Top events";
  const periodNote = `One point per ${bucket} · UTC${bucket === "week" ? " (Monday start)" : ""} · ${partialBucketNote(range, bucket)}`;
  return (
    <>
      <PageHeader
        title={source ? `${product.name} / ${source.name}` : product.name}
        description="Usage, reach, and performance at a glance."
      >
        <OverviewActions filters={eventFilters} />
      </PageHeader>
      {selectedFilter && (
        <section className="overview-filter-bar" aria-label="Applied filter">
          <Button
            variant="secondary"
            onClick={() => update({ filter: undefined })}
            aria-label="Remove filter"
          >
            {selectedFilter.field.replace("property:", "")}:{" "}
            {displayValue(selectedFilter.field, selectedFilter.value)} ×
          </Button>
          <Link
            to="/$orgSlug/$projectSlug/events"
            params={{ orgSlug: orgSlug ?? "", projectSlug: product.slug }}
            search={{
              drilldown: {
                ...range,
                sourceId,
                event: selectedFilter.field === "name" ? String(selectedFilter.value) : undefined,
                source:
                  selectedFilter.field === "source" ? String(selectedFilter.value) : undefined,
                filter: selectedFilter.field.startsWith("property:")
                  ? { property: selectedFilter.field.slice(9), value: selectedFilter.value }
                  : undefined,
              },
            }}
          >
            View matching events
          </Link>
        </section>
      )}
      <ChartAudience value={[eventFilters]}>
        <div className="overview-dashboard">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ValueSelect
              className="w-fit"
              label="Metric set"
              value={websiteMetric ? "web" : "general"}
              onValueChange={(v) => setChartMetric(v === "web" ? "web_page_views" : "count")}
              options={[
                ["general", "Product metrics"],
                ["web", "Website metrics"],
              ]}
            />
            <CohortPicker
              project={product.id}
              value={
                selectedFilter?.field.startsWith("property:cohort.")
                  ? selectedFilter.field.slice(16)
                  : undefined
              }
              change={(v) =>
                update({ filter: v ? { field: `property:cohort.${v}`, value: true } : undefined })
              }
            />
          </div>
          {websiteMetric ? (
            <WebTiles result={website} selected={websiteMetric} select={selectWeb} />
          ) : (
            <section className="overview-metrics" aria-label="Key metrics">
              <article className="metric-widget live-metric" aria-label="Active now">
                <span className="metric-label">
                  <i className="live-dot" aria-hidden="true" />
                  Active now
                </span>
                <WidgetValue
                  value={
                    active.error
                      ? "—"
                      : active.data?.events && !active.data.active
                        ? "—"
                        : number(active.data?.active)
                  }
                  label={
                    active.error
                      ? "Live activity unavailable"
                      : "Identified actors · last 5 minutes"
                  }
                  loading={active.loading}
                />
                <div
                  className="relative flex h-7 shrink-0 items-end gap-px"
                  role="img"
                  aria-label={
                    active.data
                      ? `Active actors per minute over the last 30 minutes, oldest first: ${active.data.minutes.join(", ")}`
                      : "Live activity chart unavailable"
                  }
                >
                  {active.data?.minutes.map((n, i) => (
                    <span
                      key={i}
                      className="min-w-0 flex-1 bg-data-tertiary"
                      style={{
                        height: `${Math.max(n ? 4 : 0, (n / Math.max(1, ...active.data!.minutes)) * 100)}%`,
                      }}
                      title={`${30 - i} min ago: ${n}`}
                    />
                  ))}
                  {active.data && (
                    <TimelineMarkers
                      from={new Date(now - 1800000).toISOString()}
                      to={new Date(now).toISOString()}
                    />
                  )}
                </div>
              </article>
              {[
                {
                  label: "Events",
                  value: number(s?.total),
                  detail: "In selected period",
                  change: growth(s?.total, p?.total, { range }),
                },
                {
                  label: "Visitors",
                  value: number(s?.visitors),
                  detail: "Unique visitor IDs",
                  change: growth(s?.visitors, p?.visitors, { range }),
                },
                {
                  label: "Installations",
                  value: number(s?.installations),
                  detail: "Unique installation IDs",
                  change: growth(s?.installations, p?.installations, { range }),
                },
                {
                  label: "Success rate",
                  value: s?.success_rate == null ? "—" : `${number(s.success_rate, 1)}%`,
                  detail: "Among reported outcomes",
                  change: growth(s?.success_rate, p?.success_rate, { range, points: 1 }),
                },
                {
                  label: "Avg. duration",
                  value: s?.avg_duration == null ? "—" : `${number(s.avg_duration)} ms`,
                  detail: "Numeric durations only",
                  change: growth(s?.avg_duration, p?.avg_duration, { range, lowerIsBetter: true }),
                },
              ].map((item) => (
                <article className="metric-widget" key={item.label}>
                  <span className="metric-label">{item.label}</span>
                  {item.label === "Visitors" && source?.visitor_mode === "off" ? (
                    <p className="text-xs">
                      Visitor counting is off for this source.{" "}
                      <Link
                        className="text-primary underline"
                        to="/$orgSlug/$projectSlug/settings"
                        params={{ orgSlug: orgSlug ?? "", projectSlug: product.slug }}
                      >
                        Source settings
                      </Link>
                    </p>
                  ) : (
                    <WidgetValue
                      value={query.error && !s ? "—" : item.value}
                      label={item.detail}
                      growth={item.change}
                      compactGrowth
                      loading={query.loading}
                      growthLoading={query.loading || previous.loading}
                    />
                  )}
                </article>
              ))}
            </section>
          )}
          <div
            className="overview-grid"
            data-source-comparison={showSources}
            aria-busy={query.loading}
          >
            {websiteMetric ? (
              <WebChart result={website} selected={websiteMetric} select={selectWeb} />
            ) : (
              <OverviewWidget
                title="Activity over time"
                className="activity-widget"
                error={activity.error}
                retry={refresh}
                footer={<span className="chart-period-note">{periodNote}</span>}
              >
                <div className="widget-value-row">
                  <WidgetValue
                    value={`${number(activity.data?.summary.value, 0)}${choice.unit ? " ms" : ""}`}
                    label={choice.label}
                    growth={growth(activity.data?.summary.value, baseline.data?.summary.value, {
                      range,
                      lowerIsBetter: choice.lowerIsBetter,
                    })}
                    loading={activity.loading}
                    growthLoading={activity.loading || baseline.loading}
                  />
                  <ValueSelect
                    label="Chart metric"
                    disabled={query.loading}
                    value={choice.id}
                    onValueChange={setChartMetric}
                    options={chartChoices.map((option) => [option.id, option.label])}
                  />
                </div>
                <ActivityChartKey
                  range={range}
                  available={!!comparison}
                  pending={baseline.loading}
                  failed={!!baseline.error}
                />
                <div className="widget-plot chart-plot" aria-busy={activity.loading}>
                  <WidgetContent label="chart" loading={activity.loading} empty={chartEmpty}>
                    <ChartAudience
                      value={[{ ...eventFilters, identity_kind: choice.identity_kind }]}
                    >
                      <AnalyticsChart
                        series={activity.data?.series ?? []}
                        comparison={comparison}
                        label={choice.label}
                        bucket={bucket}
                        unit={choice.unit}
                        range={range}
                      />
                    </ChartAudience>
                  </WidgetContent>
                </div>
              </OverviewWidget>
            )}
            <OverviewWidget
              title="Breakdown"
              className="breakdown-widget"
              controls={
                <ValueSelect
                  label="Breakdown"
                  value={dimension}
                  onValueChange={setDimension}
                  options={dimensions}
                />
              }
              error={breakdown.error}
              retry={refresh}
              footer={
                <div className="flex items-center justify-between">
                  <span>{number(s?.total)} events in this range</span>
                  <BreakdownReport
                    key={dimension}
                    title={dimensionLabel}
                    dimension={dimension}
                    filters={eventFilters}
                  />
                </div>
              }
            >
              <WidgetContent
                label="breakdown"
                loading={breakdown.loading}
                empty={!breakdown.data ? "Breakdown unavailable." : noEvents}
              >
                <section className="widget-ranking breakdowns" aria-label={dimensionLabel}>
                  <BreakdownRows
                    destination="overview"
                    sources={product.sources}
                    title={dimensionLabel}
                    groups={
                      dimension === "source_id"
                        ? sourceGroups(breakdown.data?.groups ?? [], product.sources)
                        : displayGroups(breakdown.data?.groups ?? [], dimension)
                    }
                    total={breakdown.data?.summary.total}
                    drilldown={(group) => drilldown(dimension, group)}
                    externalHref={(group) =>
                      reportLink(
                        dimension,
                        group.label,
                        sourceWebsite(source) ?? product.website_url,
                      )
                    }
                  />
                </section>
              </WidgetContent>
            </OverviewWidget>
            {showSources && (
              <OverviewWidget
                title="Sources"
                className="sources-widget"
                error={sources.error}
                retry={refresh}
                footer={
                  sources.data
                    ? `${number(sources.data.summary.total)} events in this range`
                    : "Share of events by source"
                }
              >
                <WidgetContent
                  label="sources"
                  loading={sources.loading}
                  empty={!sources.data ? "Sources unavailable." : undefined}
                >
                  <section className="widget-ranking breakdowns" aria-label="Source distribution">
                    <BreakdownRows
                      destination="overview"
                      sources={product.sources}
                      title="Source"
                      groups={sourceSlices.map(
                        (slice) =>
                          slice.group ?? {
                            label: null,
                            display: slice.label,
                            value: slice.value,
                            count: slice.value,
                          },
                      )}
                      total={sources.data?.summary.total}
                      drilldown={(group) => drilldown("source_id", group)}
                    />
                  </section>
                </WidgetContent>
              </OverviewWidget>
            )}
            {!showSources && (
              <OverviewWidget
                title="Identified actors"
                className="audience-widget"
                error={query.error ?? (canCompareSources ? sources.error : undefined)}
                retry={refresh}
                footer="Identity kinds are counted separately. IDs are optional."
              >
                <WidgetValue
                  value={s?.total && !s.actors ? "—" : number(s?.actors)}
                  label="distinct identities"
                  loading={query.loading}
                  detail={s?.sessions ? `${number(s.sessions)} website sessions` : undefined}
                />
                <WidgetContent
                  label="identities"
                  loading={query.loading}
                  empty={
                    !query.data
                      ? "Identities unavailable."
                      : (noEvents ??
                        (!s?.actors
                          ? "No actor IDs received. Anonymous events still count toward activity."
                          : undefined))
                  }
                >
                  <div className="audience-bars">
                    <BreakdownRows title="Identity kind" groups={actorGroups} unit="Actors" />
                  </div>
                </WidgetContent>
              </OverviewWidget>
            )}
            <OverviewWidget
              title="Success rate"
              className="outcomes-widget"
              error={query.error}
              retry={refresh}
              footer="Among events reporting a boolean success value"
            >
              <WidgetContent
                label="outcomes"
                loading={query.loading}
                empty={
                  !query.data
                    ? "Outcomes unavailable."
                    : (noEvents ??
                      (s?.success_rate == null
                        ? "No success values received. Send a boolean success property to measure outcomes."
                        : undefined))
                }
              >
                <WidgetValue
                  value={`${number(s?.success_rate, 1)}%`}
                  label="succeeded"
                  loading={query.loading}
                />
                <BreakdownRows
                  title="Outcome"
                  unit="Percent"
                  groups={[
                    { label: "Succeeded", value: s?.success_rate ?? 0, count: 0 },
                    { label: "Failed", value: 100 - (s?.success_rate ?? 0), count: 0 },
                  ]}
                />
              </WidgetContent>
            </OverviewWidget>
            <OverviewWidget
              title="Duration"
              className="duration-widget"
              controls={
                <ToggleGroup
                  aria-label="Duration measure"
                  variant="outline"
                  spacing={0}
                  value={[durationMetric]}
                  onValueChange={(values) => {
                    if (values[0]) setDurationMetric(values[0]);
                  }}
                >
                  <ToggleGroupItem value="avg">Average</ToggleGroupItem>
                  <ToggleGroupItem value="p95">p95</ToggleGroupItem>
                </ToggleGroup>
              }
              error={query.error}
              retry={refresh}
              footer={
                !hasDuration
                  ? "Only numeric duration_ms values are included"
                  : durationMetric === "avg"
                    ? "Among events reporting a numeric duration"
                    : "95% of recorded durations were at or below this"
              }
            >
              <WidgetValue
                value={
                  s?.avg_duration == null
                    ? "—"
                    : `${number(durationMetric === "avg" ? s.avg_duration : s.p95_duration)} ms`
                }
                label={durationMetric === "avg" ? "Average duration" : "p95 duration"}
                loading={query.loading}
              />
              <WidgetContent
                label="duration"
                loading={query.loading}
                empty={
                  noEvents ??
                  (!hasDuration ? "No numeric durations received in this range." : undefined)
                }
              >
                <BreakdownRows
                  title="Measure"
                  unit="Milliseconds"
                  groups={[
                    { label: "Average", value: s?.avg_duration ?? 0, count: 0 },
                    { label: "95th percentile", value: s?.p95_duration ?? 0, count: 0 },
                  ]}
                />
              </WidgetContent>
            </OverviewWidget>
            {websiteMetric && <WebsiteReports filters={eventFilters} goals={conversionNames} />}
            {conversionNames.length > 0 && (
              <OverviewWidget
                title="Conversions"
                error={conversions.error}
                retry={refresh}
                footer="Events marked as conversions in the event catalog"
              >
                <WidgetValue
                  label="conversion events"
                  value={number(conversions.data?.summary.total)}
                  loading={conversions.loading}
                />
                <WidgetContent
                  label="conversion events"
                  loading={conversions.loading}
                  empty={
                    conversions.data?.summary.total === 0
                      ? "No conversions in this range."
                      : undefined
                  }
                >
                  <div className="widget-ranking">
                    <BreakdownRows
                      title="Conversion"
                      groups={conversions.data?.groups ?? []}
                      total={conversions.data?.summary.total}
                      destination="overview"
                      sources={product.sources}
                      drilldown={(g) => drilldown("name", g)}
                    />
                  </div>
                </WidgetContent>
              </OverviewWidget>
            )}
          </div>
        </div>
      </ChartAudience>
    </>
  );
}
