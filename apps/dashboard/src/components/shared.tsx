import { useWorkspaceTarget } from "@/lib/workspace-route";
import { Skeleton } from "@/components/ui/skeleton";
import { bucketLabels, partialBucketNote, type TimeBucket } from "@/lib/time-buckets";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AnalyticsUpIcon,
  LinkSquare02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Link, useParams } from "@tanstack/react-router";
import { AnalyticsChart } from "@/components/analytics-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { groupLabel, number, type Group, type QueryResult, type Source } from "@/lib/api";
import type { ExploreDrilldown } from "@/lib/explore-search";
import { sourceParam } from "@/lib/workspace-search";
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Couldn’t load this view</AlertTitle>
      <AlertDescription>
        {message}
        {retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            <HugeiconsIcon
              icon={RefreshIcon}
              strokeWidth={2}
              aria-hidden="true"
              data-icon="inline-start"
            />
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
export function QueryDraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div className="query-draft-notice" role="status">
      <span>Changes not applied</span>
      <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
        Discard changes
      </Button>
    </div>
  );
}
export function NoEvents() {
  const workspaceTarget = useWorkspaceTarget();
  const { projectSlug } = useParams({ strict: false });
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={AnalyticsUpIcon} strokeWidth={2} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No events in this range</EmptyTitle>
        <EmptyDescription>
          No events match this date range. Try a wider range or connect your project in Settings.
        </EmptyDescription>
      </EmptyHeader>
      <Button
        variant="outline"
        nativeButton={false}
        role="link"
        render={<Link {...workspaceTarget("/settings", projectSlug)} />}
      >
        Connect a product
        <HugeiconsIcon
          icon={ArrowRight02Icon}
          strokeWidth={2}
          aria-hidden="true"
          data-icon="inline-end"
        />
      </Button>
    </Empty>
  );
}
export function SeriesChart({
  data,
  title,
  description,
  label = "Events",
  controls,
  bucket = "day",
  unit,
  range,
  pending = false,
  error,
  retry,
  emptyMessage,
}: {
  data?: QueryResult;
  title: string;
  description: string;
  label?: string;
  controls?: ReactNode;
  bucket?: TimeBucket;
  unit?: string;
  range?: { from: string; to: string };
  pending?: boolean;
  error?: string;
  retry?: () => void;
  emptyMessage?: string;
}) {
  return (
    <Card className={`chart-card${controls ? " chart-card-interactive" : ""}`}>
      <CardHeader>
        <div className="card-heading">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="chart-legend">
            <span />
            {label}
          </div>
        </div>
        {controls}
      </CardHeader>
      <CardContent>
        <div className="chart-plot" aria-busy={pending}>
          {pending ? (
            <div
              className="series-chart chart-placeholder"
              role="status"
              aria-label="Loading chart"
            >
              <Skeleton className="h-full w-full" aria-hidden="true" />
              <span className="sr-only">Loading chart</span>
            </div>
          ) : !data || emptyMessage ? (
            <div className="series-chart chart-message" role="status">
              {emptyMessage ?? "Chart unavailable."}
            </div>
          ) : (
            <AnalyticsChart
              series={data.series}
              label={label}
              bucket={bucket}
              unit={unit}
              range={range}
            />
          )}
          {error && (
            <div className="chart-error" role="alert">
              <span>
                {data ? "Couldn’t refresh chart. " : "Couldn’t load chart. "}
                {error}
              </span>
              <Button variant="outline" size="sm" onClick={retry}>
                Retry chart
              </Button>
            </div>
          )}
        </div>
        {range && (
          <p className="chart-period-note">
            {bucketLabels[bucket]} · UTC{bucket === "week" ? " (Monday start)" : ""} ·{" "}
            {partialBucketNote(range, bucket)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
type BreakdownProps = {
  title: string;
  groups: Group[];
  unit?: string;
  total?: number;
  drilldown?: (group: Group) => ExploreDrilldown | undefined;
  destination?: "overview" | "events";
  /** The project's sources, so Overview links can name a source by its slug. */
  sources?: Source[];
  externalHref?: (group: Group) => string | undefined;
};
export function Breakdown({ description, ...props }: BreakdownProps & { description: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <BreakdownRows {...props} />
      </CardContent>
    </Card>
  );
}
export function BreakdownRows({
  title,
  groups,
  unit = "Events",
  total,
  drilldown,
  externalHref,
  destination = "events",
  sources,
}: BreakdownProps) {
  const workspaceTarget = useWorkspaceTarget();
  const { projectSlug } = useParams({ strict: false });
  const max = Math.max(...groups.map((g) => g.value ?? 0), 1);
  return (
    <>
      <div className="breakdown-head">
        <span>{title}</span>
        <span>
          {unit}
          {total !== undefined ? " · Share" : ""}
        </span>
      </div>
      {groups.length ? (
        groups.map((g) => {
          const target = drilldown?.(g);
          const href = externalHref?.(g);
          const label = g.display ?? groupLabel(g.label);
          const content = (
            <>
              <div
                className="breakdown-fill"
                style={{ width: `${Math.max(0, (g.value ?? 0) / max) * 85}%` }}
              />
              {target ? (
                <Link
                  className="breakdown-label breakdown-filter"
                  {...workspaceTarget(destination === "overview" ? "/" : "/events", projectSlug)}
                  search={(previous) =>
                    destination === "overview"
                      ? {
                          ...previous,
                          source: sourceParam(sources, target.sourceId),
                          filter: target.event
                            ? { field: "name", value: target.event }
                            : target.source
                              ? { field: "source", value: target.source }
                              : target.filter
                                ? {
                                    field: `property:${target.filter.property}`,
                                    value: target.filter.value,
                                  }
                                : previous.filter,
                        }
                      : { drilldown: target }
                  }
                  aria-label={`${destination === "overview" ? "Filter by" : "Events for"} ${label}`}
                  title={label}
                >
                  <span className="breakdown-link-text">{label}</span>
                </Link>
              ) : (
                <span className="breakdown-label" title={label}>
                  {label}
                </span>
              )}
              {href && (
                <a
                  className="breakdown-external"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${label} in a new tab`}
                  title="Open in a new tab"
                >
                  <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} aria-hidden="true" />
                </a>
              )}
              <span className="breakdown-values">
                <span className="breakdown-value">{number(g.value, 1)}</span>
                {total !== undefined && (
                  <span className="breakdown-share">
                    {number(total ? (g.count / total) * 100 : 0, 1)}%
                  </span>
                )}
                {target && (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    className="breakdown-arrow"
                    aria-hidden="true"
                  />
                )}
              </span>
            </>
          );
          return (
            <div className="breakdown-row" key={JSON.stringify(g.label)}>
              {content}
            </div>
          );
        })
      ) : (
        <p className="quiet">No values in this range.</p>
      )}
    </>
  );
}

/** A narrowing the builder has no row for, with a button that removes it. */
export function PinChip({
  label,
  remove,
  onRemove,
}: {
  label: string;
  remove: string;
  onRemove: () => void;
}) {
  return (
    <Badge variant="outline" className="drilldown-property">
      {label}
      <button type="button" aria-label={remove} onClick={onRemove}>
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden="true" className="size-3" />
      </button>
    </Badge>
  );
}

export type Pin = { label: string; remove: string; onRemove: () => void };
/**
 * What a query applies beyond its controls, as removable chips. Removing one moves focus to the
 * chip that takes its place (or the one before it), and to `fallback` when none remain, so the
 * keyboard never drops to the page. Renders nothing without pins but stays mounted to place focus.
 */
export function PinChips({ pins, fallback }: { pins: Pin[]; fallback: () => HTMLElement | null }) {
  const section = useRef<HTMLElement>(null);
  const removed = useRef<{ index: number; count: number } | null>(null);
  // Removal re-renders after the URL changes; focus moves once the chip is gone.
  useLayoutEffect(() => {
    const last = removed.current;
    if (!last || pins.length >= last.count) return;
    removed.current = null;
    const buttons = section.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    (buttons[Math.min(last.index, buttons.length - 1)] ?? fallback())?.focus();
  });
  if (!pins.length) return null;
  // A filter written twice is two chips, so keys count repeats.
  const seen = new Map<string, number>();
  return (
    <section ref={section} className="drilldown-filters query-pins" aria-label="Also applied">
      {pins.map((pin, index) => {
        const repeat = seen.get(pin.label) ?? 0;
        seen.set(pin.label, repeat + 1);
        return (
          <PinChip
            key={`${pin.label}#${repeat}`}
            label={pin.label}
            remove={pin.remove}
            onRemove={() => {
              removed.current = { index, count: pins.length };
              pin.onRemove();
            }}
          />
        );
      })}
    </section>
  );
}
