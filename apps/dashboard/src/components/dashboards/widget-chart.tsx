import {
  areaY,
  barY,
  defineChart,
  dot,
  group,
  lineY,
  ruleY,
  type ChartPoint,
} from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useId, useMemo } from "react";
import {
  comparesPreviousPeriod,
  formatMeasure,
  thresholdColor,
  type Color,
  type RunResult,
  type Series,
  type Threshold,
  type View,
} from "@/lib/dashboards";
import { nextBucket, type TimeBucket } from "@/lib/time-buckets";
import { formatDate, TONE_BANDS, ZoomableChart } from "../analytics-chart";

/** Palette tokens as CSS colors; data never uses orange, which marks actions and selection. */
export const colorVar: Record<Color, string> = {
  yellow: "var(--data)",
  violet: "var(--data-secondary)",
  aqua: "var(--data-tertiary)",
  green: "var(--success)",
  red: "var(--destructive)",
  neutral: "var(--muted-foreground)",
};

export type ChartSeries = {
  key: string;
  label: string;
  color: Color;
  /** A repeated hue: dotted lines and checkered fills keep it distinct from the solid series. */
  dither: boolean;
  thresholds: Threshold[];
  total: number | null;
  points: Map<number, number | null>;
};
type Bucket = {
  time: number;
  values: (number | null)[];
  /** Stacked bounds per series, when the view stacks. */
  lower: number[];
  upper: number[];
  previous: number | null;
};
type Row = { time: number; value: number | null; lower: number; upper: number; series: number };

/**
 * Each result series becomes one legend entry. A hue that an earlier series already uses is
 * drawn dithered, so grouped series 4–6 (and any repeated choice) stay distinguishable.
 */
export function chartSeries(
  results: RunResult["series"],
  definitions: Series[] | undefined,
  label: (series: RunResult["series"][number], index: number) => string,
): ChartSeries[] {
  const grouped = results.some((series) => series.group !== undefined);
  return results.map((series, index) => ({
    key: series.group !== undefined ? `group:${JSON.stringify(series.group)}` : `series:${index}`,
    label: label(series, index),
    color: series.color,
    dither: results.slice(0, index).some((earlier) => earlier.color === series.color),
    thresholds: (grouped ? definitions?.[0] : definitions?.[index])?.thresholds ?? [],
    total: series.total,
    points: new Map((series.points ?? []).map((point) => [point.time, point.value])),
  }));
}

/**
 * Line, area and bar widgets on TanStack Charts, in the Overview chart's language: angular lines,
 * dithered fills, sparse axes, UTC buckets, keyboard inspection and drag-to-zoom.
 */
export function WidgetChart({
  result,
  view,
  bucket,
  range,
  series,
  label,
  zoom = true,
}: {
  result: RunResult;
  view: View;
  bucket: TimeBucket;
  range: { from: string; to: string };
  series: ChartSeries[];
  label: string;
  /** Widgets with their own range ignore the workspace dates, so they do not zoom them. */
  zoom?: boolean;
}) {
  const toneId = `highkey-widget-${useId().replace(/[^\w-]/g, "")}`;
  const kind = view.type === "bar" || view.type === "area" ? view.type : "line";
  const stacked = !!view.stacked && kind !== "line" && series.length > 1;
  const previous = result.series[0]?.previous_points;
  const compare = comparesPreviousPeriod(view) && !!previous && series.length > 0;
  const { from, to } = range;
  const buckets = useMemo(() => {
    const times = [...new Set(series.flatMap((s) => [...s.points.keys()]))].sort((a, b) => a - b);
    return times.map((time, index): Bucket => {
      const values = series.map((s) => s.points.get(time) ?? null);
      const lower: number[] = [];
      const upper: number[] = [];
      let sum = 0;
      for (const value of values) {
        lower.push(sum);
        if (stacked) sum += value ?? 0;
        upper.push(stacked ? sum : (value ?? 0));
      }
      // The previous period lines up bucket by bucket from its start.
      return {
        time,
        values,
        lower,
        upper,
        previous: compare ? (previous?.[index]?.value ?? null) : null,
      };
    });
  }, [series, stacked, compare, previous]);
  const colors = [...new Set(series.map((s) => s.color))];

  const definition = useMemo(() => {
    const format = (value: number | null) => formatMeasure(value, view);
    const tick = (value: number) =>
      formatMeasure(value, { unit: view.unit, prefix: view.prefix, suffix: view.suffix });
    const rows = (index: number): Row[] =>
      buckets.map((b) => ({
        time: b.time,
        value: b.values[index],
        lower: b.lower[index],
        upper: b.upper[index],
        series: index,
      }));
    const all = buckets.flatMap((b) => [...b.values, ...(stacked ? b.upper : []), b.previous]);
    const finite = all.filter((v): v is number => v !== null && Number.isFinite(v));
    const guides = series[0]?.thresholds ?? [];
    const peak = Math.max(0, ...finite, ...guides.map((t) => t.at));
    const floor = Math.min(0, ...finite, ...guides.map((t) => t.at));
    const step =
      buckets.length > 1
        ? Math.min(...buckets.slice(1).map((b, i) => b.time - buckets[i].time))
        : nextBucket(buckets[0]?.time ?? 0, bucket) - (buckets[0]?.time ?? 0);
    const first = buckets[0]?.time ?? 0;
    const last = buckets.at(-1)?.time ?? first;
    const fill = (s: ChartSeries, density: 25 | 50) => `url(#${toneId}-${density}-${s.color})`;
    const marks = series.flatMap((s, index) => {
      const data = rows(index);
      const stroke = colorVar[s.color];
      const dash = s.dither ? "2 2" : undefined;
      const lonely = data.filter((row) => row.value !== null).length === 1;
      const top = (row: Row) => (row.value === null ? null : row.upper);
      if (kind === "bar") {
        if (series.length > 1 && !stacked) return [];
        return [
          decorative(
            barY(data, {
              id: `series-${index}`,
              x: "time",
              y1: (row) => (row.value === null ? null : row.lower),
              y2: top,
              fill: (row) =>
                s.dither ? fill(s, 50) : colorVar[thresholdColor(row.value, s.thresholds, s.color)],
              inset: 1,
            }),
          ),
        ];
      }
      const line = decorative(
        lineY(data, {
          id: `series-${index}`,
          x: "time",
          y: top,
          stroke,
          strokeWidth: 2,
          strokeDasharray: dash,
          points: lonely,
        }),
      );
      if (kind === "line") return [line];
      if (series.length === 1 && !s.dither) {
        // One area keeps Overview's falloff: dense under the line, thinning to the baseline.
        return [
          ...TONE_BANDS.map((band) =>
            decorative(
              areaY(data, {
                id: `series-${index}-area-${band.density}`,
                x: "time",
                y1: (row) => (row.value === null ? null : Math.max(0, row.value - band.to * peak)),
                y2: (row) =>
                  row.value === null ? null : Math.max(0, row.value - band.from * peak),
                fill: `url(#${toneId}-${band.density}-${s.color})`,
              }),
            ),
          ),
          line,
        ];
      }
      return [
        decorative(
          areaY(data, {
            id: `series-${index}-area`,
            x: "time",
            y1: (row) => (row.value === null ? null : stacked ? row.lower : 0),
            y2: top,
            fill: fill(s, s.dither ? 50 : 25),
          }),
        ),
        line,
      ];
    });
    // Unstacked bars of several series sit side by side within each bucket.
    const groupedBars =
      kind === "bar" && series.length > 1 && !stacked
        ? [
            decorative(
              barY(
                series.flatMap((_, index) => rows(index)),
                {
                  id: "series-bars",
                  x: "time",
                  y: "value",
                  z: "series",
                  layout: group({ padding: 0.1 }),
                  fill: (row) => {
                    const s = series[row.series];
                    return s.dither
                      ? fill(s, 50)
                      : colorVar[thresholdColor(row.value, s.thresholds, s.color)];
                  },
                },
              ),
            ),
          ]
        : [];
    const ghost = compare
      ? [
          decorative(
            lineY(buckets, {
              id: "previous-period",
              x: "time",
              y: "previous",
              stroke: "var(--muted-foreground)",
              strokeWidth: 2,
              strokeDasharray: "2 4",
            }),
          ),
        ]
      : [];
    const rules = guides.length
      ? [
          decorative(
            ruleY(guides, {
              id: "thresholds",
              y: (threshold) => threshold.at,
              stroke: (threshold) => colorVar[threshold.color],
              strokeWidth: 1,
              strokeDasharray: "2 4",
            }),
          ),
        ]
      : [];
    return defineChart({
      svgAnimation: false,
      focus: "nearest-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      focusRing: false,
      tooltip: {
        use: tooltip,
        motion: false,
        content: (points: readonly ChartPoint<Bucket, number, number>[]) => {
          const point = points[0];
          if (!point) return { rows: [] };
          const { time, values, previous: before } = point.datum;
          const partial = time < Date.parse(from) || nextBucket(time, bucket) > Date.parse(to);
          return {
            title: `${bucket === "week" ? "Week of " : ""}${formatDate(time, bucket, true)} UTC${partial ? ` · partial ${bucket}` : ""}`,
            rows: [
              ...series.map((s, index) => ({ label: s.label, value: format(values[index]) })),
              ...(compare ? [{ label: previousLabel(series), value: format(before) }] : []),
            ],
          };
        },
      },
      chart: ({ width }) => {
        // As many date labels as fit (hours read longer), at most seven like Overview's chart.
        const room = Math.floor(width / (bucket === "hour" ? 140 : 76));
        const count = Math.min(buckets.length, Math.max(2, Math.min(room, 7)));
        const ticks = Array.from(
          { length: count },
          (_, index) =>
            buckets[count === 1 ? 0 : Math.round((index * (buckets.length - 1)) / (count - 1))]
              .time,
        );
        // Bars need half a bucket of room at each end of the time axis.
        const pad = kind === "bar" ? step / 2 : 0;
        return {
          marks: [
            ...rules,
            ...ghost,
            ...marks,
            ...groupedBars,
            // Invisible focus targets per bucket: keyboard inspection, tooltips and zoom.
            dot(buckets, {
              id: "buckets",
              key: "time",
              x: "time",
              y: (b) => Math.max(0, ...b.upper),
              r: 0,
            }),
            crosshair({ x: { stroke: "var(--muted-foreground)", strokeWidth: 1 }, y: false }),
          ],
          scales: {
            x: {
              scale: scaleLinear().domain([first - pad, last + pad]),
              axis: {
                line: false,
                tickLabels: { fontSize: 11, opacity: 1 },
                ticks: {
                  values: ticks,
                  size: 0,
                  padding: 10,
                  format: (time) => formatDate(time, bucket),
                },
              },
            },
            y: {
              scale: scaleLinear().domain([floor, peak > floor ? peak : floor + 1]),
              nice: true,
              grid: { stroke: "var(--border)", strokeOpacity: 1, strokeDasharray: "2 5" },
              axis: {
                line: false,
                tickLabels: { fontSize: 11, opacity: 1 },
                ticks: { count: 3, size: 0, padding: 8, format: tick },
              },
            },
          },
          margin: { top: 8 },
          theme: {
            foreground: "var(--foreground)",
            muted: "var(--muted-foreground)",
            grid: "var(--border)",
            background: "transparent",
          },
        };
      },
    });
  }, [buckets, series, kind, stacked, compare, bucket, from, to, toneId, view]);

  return (
    <ZoomableChart bucket={bucket} to={to} enabled={zoom && buckets.length >= 2}>
      <Chart
        definition={definition}
        onRender={({ svg, interaction }) => {
          svg.onkeydown = (event) => {
            if (event.key === "Escape") interaction.setControlledFocus(null);
          };
        }}
        className="analytics-plot"
        style={{ height: "100%", touchAction: "pan-y pinch-zoom" }}
        ariaLabel={`${label} by UTC ${bucket === "day" ? "date" : bucket}`}
        ariaDescription="Use Left and Right arrows to inspect values, Home and End for the first and last bucket, and Escape to dismiss."
      />
      <svg className="dither-defs" aria-hidden="true" focusable="false" width="0" height="0">
        {colors.flatMap((color) =>
          TONE_BANDS.map((band) => (
            <pattern
              key={`${band.density}-${color}`}
              id={`${toneId}-${band.density}-${color}`}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
            >
              <path d={band.path} style={{ fill: colorVar[color] }} />
            </pattern>
          )),
        )}
      </svg>
    </ZoomableChart>
  );
}

/** Each series named next to its swatch, with its total when it has one. */
export function ChartLegend({
  series,
  view,
  previous,
}: {
  series: ChartSeries[];
  view: View;
  previous?: number | null;
}) {
  return (
    <ul className="dashboard-legend" aria-label="Series">
      {series.map((s) => (
        <li key={s.key} data-color={s.color} data-dither={s.dither ? "" : undefined}>
          <span className="dashboard-swatch" aria-hidden="true" />
          <span className="dashboard-legend-label" title={s.label}>
            {s.label}
          </span>
          {s.total !== null && (
            <span className="dashboard-legend-value">{formatMeasure(s.total, view)}</span>
          )}
        </li>
      ))}
      {previous !== undefined && (
        <li data-color="neutral" data-previous="">
          <span className="dashboard-swatch" aria-hidden="true" />
          <span className="dashboard-legend-label">{previousLabel(series)}</span>
          <span className="dashboard-legend-value">{formatMeasure(previous, view)}</span>
        </li>
      )}
    </ul>
  );
}

/** The ghost line compares the first series with the period just before the range. */
export const previousLabel = (series: ChartSeries[]) =>
  series.length > 1 ? `${series[0].label}, previous period` : "Previous period";
