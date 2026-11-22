import { DAY_MS, type AnalyticsRange } from "./date-range";
export type TimeBucket = "minute" | "hour" | "day" | "week" | "month";

export const bucketLabels: Record<TimeBucket, string> = {
  minute: "Per minute",
  hour: "Hourly",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** Choose chart detail from the selected dates, independently of the event volume. */
export function automaticBucket(range: AnalyticsRange): TimeBucket {
  return bucketForSpan(Date.parse(range.to) - Date.parse(range.from));
}
export function bucketForSpan(span: number): TimeBucket {
  if (span <= 3_600_000) return "minute";
  return span <= 2 * DAY_MS ? "hour" : "day";
}

/** Thin the UTC axis labels, never the points available to the plot, tooltip or keyboard. */
export function timeAxisTicks(
  points: readonly { time: number }[],
  bucket: TimeBucket,
  width: number,
) {
  const spacing = bucket === "hour" || bucket === "minute" ? 132 : 76;
  const room = Math.max(2, Math.floor((width - 40) / spacing));
  if (bucket === "day" && points.length / room > 16) {
    const months = points.filter(({ time }) => new Date(time).getUTCDate() === 1);
    if (months.length >= 2) {
      const step = [1, 2, 3, 6, 12].find((n) => months.length <= room * n) ?? 12;
      const values = months.filter(({ time }) => new Date(time).getUTCMonth() % step === 0);
      return { values: values.map(({ time }) => time), labelBucket: "month" as const };
    }
  }
  if (bucket === "day" && points.length / room >= 6) {
    const weeks = points.filter(({ time }) => new Date(time).getUTCDay() === 1);
    const step = Math.max(1, Math.ceil(weeks.length / room));
    if (weeks.length >= 2)
      return {
        values: weeks.filter((_, i) => i % step === 0).map(({ time }) => time),
        labelBucket: bucket,
      };
  }
  const count = Math.min(points.length, room);
  const values = Array.from(
    { length: count },
    (_, i) => points[Math.round((i * (points.length - 1)) / Math.max(1, count - 1))].time,
  );
  return { values, labelBucket: bucket };
}

/** Mirrors DuckDB date_trunc: UTC calendar months and Monday-based weeks. */
export function bucketStart(time: number, bucket: TimeBucket): number {
  const date = new Date(time);
  if (bucket === "minute") date.setUTCSeconds(0, 0);
  else if (bucket === "hour") date.setUTCMinutes(0, 0, 0);
  else {
    date.setUTCHours(0, 0, 0, 0);
    if (bucket === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    if (bucket === "month") date.setUTCDate(1);
  }
  return date.getTime();
}

export function nextBucket(time: number, bucket: TimeBucket): number {
  const date = new Date(bucketStart(time, bucket));
  if (bucket === "month") date.setUTCMonth(date.getUTCMonth() + 1);
  else if (bucket === "minute") date.setUTCMinutes(date.getUTCMinutes() + 1);
  else if (bucket === "hour") date.setUTCHours(date.getUTCHours() + 1);
  else date.setUTCDate(date.getUTCDate() + (bucket === "week" ? 7 : 1));
  return date.getTime();
}

export function partialBucketNote(range: { from: string; to: string }, bucket: TimeBucket) {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const first = from !== bucketStart(from, bucket);
  const last = to !== bucketStart(to, bucket);
  if (first && last) return `First and last ${bucket}s are partial.`;
  if (first) return `First ${bucket} is partial.`;
  if (last) return `Last ${bucket} is partial.`;
  return `Complete UTC ${bucket}s.`;
}
