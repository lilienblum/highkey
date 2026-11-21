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
  const days = span / DAY_MS;
  if (days <= 2) return "hour";
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
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
