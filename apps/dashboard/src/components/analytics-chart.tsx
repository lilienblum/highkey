import { areaY, defineChart, dot, lineY, type ChartPoint } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useWorkspace } from "./app-shell";
import { number, type QueryResult } from "@/lib/api";
import { nextBucket, type TimeBucket } from "@/lib/time-buckets";

// Bayer 4×4 screen tones at 2px per dither pixel (8px tiles), from the line down to the baseline.
// `from`/`to` are offsets below each value as a share of the series peak.
export const TONE_BANDS = [
  {
    density: 50,
    from: 0,
    to: 0.08,
    path: "M0 0h2v2H0zM4 0h2v2H4zM2 2h2v2H2zM6 2h2v2H6zM0 4h2v2H0zM4 4h2v2H4zM2 6h2v2H2zM6 6h2v2H6z",
  },
  { density: 25, from: 0.08, to: 0.22, path: "M0 0h2v2H0zM4 0h2v2H4zM0 4h2v2H0zM4 4h2v2H4z" },
  { density: 12, from: 0.22, to: Number.POSITIVE_INFINITY, path: "M0 0h2v2H0zM4 4h2v2H4z" },
] as const;

export function formatDate(time: number, bucket: TimeBucket, full = false) {
  return new Date(time).toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    ...(full || bucket === "month" ? { year: "numeric" as const } : {}),
    ...(bucket !== "month" ? { day: "numeric" as const } : {}),
    ...(bucket === "hour"
      ? { hour: "2-digit" as const, minute: "2-digit" as const, hourCycle: "h23" as const }
      : {}),
  });
}

export function AnalyticsChart({
  series,
  label,
  bucket,
  unit,
  range,
  compact = false,
}: {
  series: QueryResult["series"];
  label: string;
  bucket: TimeBucket;
  unit?: string;
  compact?: boolean;
  range?: { from: string; to: string };
}) {
  const from = range?.from;
  const to = range?.to;
  // Area fills use an ordered-dither screen tone instead of translucency; ids must be URL-safe.
  const toneId = `highkey-tone-${useId().replace(/[^\w-]/g, "")}`;
  const definition = useMemo(() => {
    const markers =
      (!compact && Boolean(unit)) || series.filter((point) => point.value !== null).length === 1;
    const peak = Math.max(0, ...series.map((point) => point.value ?? 0));
    return defineChart({
      svgAnimation: false,
      focus: "nearest-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      focusRing: false,
      tooltip: {
        use: tooltip,
        motion: false,
        content: (points: readonly ChartPoint<QueryResult["series"][number], number, number>[]) => {
          const point = points[0];
          if (!point) return { rows: [] };
          const { time, value } = point.datum;
          const partial =
            from && to && (time < Date.parse(from) || nextBucket(time, bucket) > Date.parse(to));
          return {
            title: `${bucket === "week" ? "Week of " : ""}${formatDate(time, bucket, true)} UTC${partial ? ` · partial ${bucket}` : ""}`,
            rows: [
              {
                label,
                value:
                  value === null
                    ? "No numeric value"
                    : `${number(value, 2)}${unit ? ` ${unit}` : ""}`,
              },
            ],
          };
        },
      },
      chart: ({ width }) => {
        const count = Math.min(series.length, width < 480 ? (bucket === "hour" ? 2 : 3) : 7);
        const ticks = Array.from(
          { length: count },
          (_, index) =>
            series[count === 1 ? 0 : Math.round((index * (series.length - 1)) / (count - 1))].time,
        );
        return {
          marks: [
            // Dithered falloff: dense under the line, thinning toward the baseline.
            ...TONE_BANDS.map((band, index) =>
              decorative(
                areaY(series, {
                  id: `values-area-${index}`,
                  x: "time",
                  y1: (point) =>
                    point.value === null ? null : Math.max(0, point.value - band.to * peak),
                  y2: (point) =>
                    point.value === null ? null : Math.max(0, point.value - band.from * peak),
                  fill: `url(#${toneId}-${band.density})`,
                }),
              ),
            ),
            decorative(
              lineY(series, {
                id: "values-line",
                x: "time",
                y: "value",
                stroke: "var(--data)",
                strokeWidth: 2,
                points: markers,
              }),
            ),
            // Invisible focus targets let missing buckets be inspected without drawing a zero.
            dot(series, {
              id: "buckets",
              key: "time",
              x: "time",
              y: (point) => point.value ?? 0,
              r: 0,
            }),
            crosshair({ x: { stroke: "var(--muted-foreground)", strokeWidth: 1 }, y: false }),
          ],
          scales: {
            x: {
              scale: scaleLinear,
              axis: {
                line: false,
                tickLabels: { fontSize: 12, opacity: 1 },
                ticks: {
                  values: ticks,
                  size: 0,
                  padding: 12,
                  format: (time) => formatDate(time, bucket),
                },
              },
            },
            y: {
              scale: scaleLinear,
              nice: true,
              grid: { stroke: "var(--border)", strokeOpacity: 1, strokeDasharray: "2 5" },
              axis: {
                line: false,
                tickLabels: { fontSize: 12, opacity: 1 },
                ticks: {
                  count: compact ? 3 : 4,
                  size: 0,
                  padding: 10,
                  format: (value) => `${number(value, 1)}${unit ? ` ${unit}` : ""}`,
                },
              },
            },
          },
          margin: { top: 12 },
          theme: {
            foreground: "var(--foreground)",
            muted: "var(--muted-foreground)",
            grid: "var(--border)",
            background: "transparent",
          },
        };
      },
    });
  }, [series, label, bucket, unit, from, to, compact, toneId]);
  return (
    <ZoomableChart bucket={bucket} to={to} enabled={series.length >= 2}>
      <Chart
        definition={definition}
        onRender={({ svg, interaction }) => {
          // TanStack 1.1 only handles Escape for pinned tooltips; preserve ordinary dismissal too.
          svg.onkeydown = (event) => {
            if (event.key === "Escape") interaction.setControlledFocus(null);
          };
        }}
        className="analytics-plot"
        style={{ height: "100%", touchAction: "pan-y pinch-zoom" }}
        ariaLabel={`${label} by UTC ${bucket === "day" ? "date" : bucket}`}
        ariaDescription="Use Left and Right arrows to inspect values, Home and End for the first and last bucket, and Escape to dismiss."
      />
      {/* Pattern definitions follow the plot so the chart stays the container's first SVG. */}
      <svg className="dither-defs" aria-hidden="true" focusable="false" width="0" height="0">
        {TONE_BANDS.map((band) => (
          <pattern
            key={band.density}
            id={`${toneId}-${band.density}`}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
          >
            <path d={band.path} />
          </pattern>
        ))}
      </svg>
    </ZoomableChart>
  );
}

/**
 * The plot container for time charts: drag across the plot (or click one bucket) to zoom the
 * workspace range to those buckets. Buckets are read from the chart's `buckets` dot mark, whose
 * keys are bucket start times.
 */
export function ZoomableChart({
  bucket,
  to,
  enabled,
  children,
}: {
  bucket: TimeBucket;
  /** The range end; a zoom never extends past it. */
  to?: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const { selectRange } = useWorkspace();
  const container = useRef<HTMLDivElement>(null);
  const [brush, setBrush] = useState<{ start: number; end: number }>();
  const buckets = () =>
    [
      ...(container.current?.querySelectorAll<SVGCircleElement>(
        'circle[data-ts-key^="buckets:"]',
      ) ?? []),
    ]
      .map((dot) => {
        const box = dot.getBoundingClientRect();
        return { time: Number(dot.dataset.tsKey?.split(":").pop()), x: box.left + box.width / 2 };
      })
      .filter((point) => Number.isFinite(point.time))
      .sort((a, b) => a.time - b.time);
  const nearest = (event: PointerEvent, points: { x: number }[]) =>
    points.reduce(
      (best, point, index) =>
        Math.abs(point.x - event.clientX) < Math.abs(points[best].x - event.clientX) ? index : best,
      0,
    );
  const points = brush ? buckets() : [];
  const edge = (index: number, side: -1 | 1) => {
    const point = points[index];
    const neighbour = points[index + side] ?? points[index - side];
    const half = neighbour ? Math.abs(neighbour.x - point.x) / 2 : 8;
    const left = container.current?.getBoundingClientRect().left ?? 0;
    return point.x - left + side * half;
  };
  return (
    <div
      ref={container}
      className="series-chart"
      data-slot="chart"
      data-chart-library="tanstack"
      data-zooming={brush ? "" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || !enabled) return;
        const all = buckets();
        if (!all.length) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const index = nearest(event, all);
        setBrush({ start: index, end: index });
      }}
      onPointerMove={(event) => {
        if (brush) setBrush({ ...brush, end: nearest(event, buckets()) });
      }}
      onPointerUp={() => {
        if (!brush) return;
        const all = buckets();
        setBrush(undefined);
        const first = all[Math.min(brush.start, brush.end)];
        const last = all[Math.max(brush.start, brush.end)];
        if (!first || !last) return;
        const end = Math.min(
          nextBucket(last.time, bucket),
          to ? Date.parse(to) : Number.POSITIVE_INFINITY,
        );
        selectRange({ from: new Date(first.time).toISOString(), to: new Date(end).toISOString() });
      }}
      onPointerCancel={() => setBrush(undefined)}
    >
      {brush && points.length > 0 && (
        <span
          className="chart-brush"
          aria-hidden="true"
          style={{
            left: edge(Math.min(brush.start, brush.end), -1),
            width:
              edge(Math.max(brush.start, brush.end), 1) -
              edge(Math.min(brush.start, brush.end), -1),
          }}
        />
      )}
      {children}
    </div>
  );
}
