import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useNearViewport } from "@/lib/use-widget";
import { useReportQuery } from "@/lib/use-query";
import { number } from "@/lib/api";
import { useWorkspace } from "./app-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Button } from "./ui/button";
import { WorldMap } from "./world-map";
import { BreakdownReport, loadBreakdown } from "./breakdown-report";
import { OverviewWidget, WidgetContent } from "./overview-widgets";
const reports = {
  Acquisition: [
    ["Referrers", "context.referrer_name"],
    ["URLs", "referrer"],
    ["Types", "context.referrer_type"],
    ["Source", "utm_source"],
    ["Medium", "utm_medium"],
    ["Campaign", "utm_campaign"],
    ["Term", "utm_term"],
    ["Content", "utm_content"],
  ],
  Pages: [
    ["Top", "path"],
    ["Entry", "page.entry"],
    ["Exit", "page.exit"],
  ],
  Devices: [
    ["Device", "context.device"],
    ["Browser", "context.browser"],
    ["Browser version", "context.browser_version"],
    ["OS", "context.os_family"],
    ["OS version", "context.os_version"],
  ],
  Location: [
    ["Country", "context.country"],
    ["Region", "context.region"],
    ["Map", "context.country"],
  ],
  Events: [
    ["Top events", "name"],
    ["Conversions", "name"],
    ["Outbound", "outbound.url"],
  ],
} as const;
export function WebsiteReports({
  filters,
  goals,
}: {
  filters: Record<string, unknown>;
  goals: string[];
}) {
  return Object.entries(reports).map(([name, tabs]) => (
    <Report key={name} name={name} tabs={tabs} filters={filters} goals={goals} />
  ));
}
function Report({
  name,
  tabs,
  filters,
  goals,
}: {
  name: string;
  tabs: readonly (readonly [string, string])[];
  filters: Record<string, unknown>;
  goals: string[];
}) {
  const { product, range, rangeScope, sourceId, refreshKey, refresh } = useWorkspace(),
    ref = useRef<HTMLDivElement>(null),
    near = useNearViewport(ref),
    [visited, setVisited] = useState(false),
    [index, select] = useState(0),
    nav = useNavigate({ from: "/$orgSlug/$projectSlug/" });
  useEffect(() => {
    if (near) setVisited(true);
  }, [near]);
  const [tab, key] = tabs[index],
    field = key === "name" ? "name" : `property:${key}`,
    emptyGoals = tab === "Conversions" && !goals.length;
  const ctx = {
    ...filters,
    ...(tab === "Conversions" ? { names: goals } : {}),
    filters: [
      ...((filters.filters as object[]) ?? []),
      ...(key === "name" ? [] : [{ property: key, op: "not_empty" }]),
    ],
  };
  const result = useReportQuery(
    loadBreakdown,
    "website-report",
    (near || visited) && !emptyGoals ? product?.id : undefined,
    {
      ...range,
      source_id: sourceId,
      ...ctx,
      dimension: field,
      page_size: tab === "Map" ? 250 : 10,
    },
    refreshKey,
    JSON.stringify([rangeScope, sourceId, name, tab, ctx]),
  );
  const rows = result.data?.rows ?? [];
  return (
    <div ref={ref} className="min-w-0">
      <OverviewWidget
        title={name}
        retry={refresh}
        error={result.error}
        footer={
          !emptyGoals && (
            <BreakdownReport key={tab} title={`${name}: ${tab}`} dimension={field} filters={ctx} />
          )
        }
      >
        <Tabs value={index} onValueChange={(i) => select(Number(i))}>
          <div className="overflow-x-auto">
            <TabsList variant="line" aria-label={`${name} reports`}>
              {tabs.map(([t], i) => (
                <TabsTrigger key={t} value={i}>
                  {t}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value={index}>
            <WidgetContent
              label={name}
              loading={near && !emptyGoals && result.loading}
              empty={
                emptyGoals
                  ? "Mark a conversion in the event catalog to see it here."
                  : result.data && !rows.length
                    ? "No observations in this period."
                    : undefined
              }
            >
              {tab === "Map" && (
                <WorldMap
                  rows={rows.flatMap((r) =>
                    typeof r.label === "string" ? [{ label: r.label, count: r.volume }] : [],
                  )}
                  label="Activity by country"
                />
              )}
              <ol className="max-h-48 overflow-y-auto">
                {rows.map((r) => (
                  <li
                    key={JSON.stringify(r.label)}
                    className="flex items-center justify-between gap-2"
                  >
                    <Button
                      variant="link"
                      size="sm"
                      className="min-w-0 truncate"
                      disabled={r.label === null}
                      onClick={() => {
                        if (r.label !== null)
                          void nav({
                            search: (s) => ({ ...s, filter: { field, value: r.label! } }),
                            resetScroll: false,
                          });
                      }}
                    >
                      {String(r.label ?? "Unassigned")}
                    </Button>
                    <span>{number(r.volume)}</span>
                  </li>
                ))}
              </ol>
            </WidgetContent>
          </TabsContent>
        </Tabs>
      </OverviewWidget>
    </div>
  );
}
