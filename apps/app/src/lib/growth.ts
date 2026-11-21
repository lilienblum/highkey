import { DAY_MS, type AnalyticsRange } from "./date-range";

export type GrowthOutcome = "good" | "bad" | "neutral" | "none";
/** `text` is the full sentence; `short` fits one line in a small tile ("+15% vs prior 7d"). */
export type Growth = { text: string; short: string; outcome: GrowthOutcome };

const HOUR_MS = 3_600_000;
const EPSILON = 1e-6;
const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/** The equal-length span immediately before a range. */
export function previousRange(range: AnalyticsRange): AnalyticsRange {
  const from = Date.parse(range.from);
  const span = Date.parse(range.to) - from;
  return { from: new Date(from - span).toISOString(), to: range.from };
}

/** The previous period's length in whole hours (up to two days) or days, rounding a partial one up. */
function periodLength(range?: AnalyticsRange) {
  const span = range ? Date.parse(range.to) - Date.parse(range.from) : Number.NaN;
  if (!(span > 0)) return;
  if (span < HOUR_MS)
    return { count: Math.max(1, Math.ceil(span / 60000 - EPSILON)), unit: "minute" as const };
  if (span <= 2 * DAY_MS)
    return { count: Math.max(1, Math.ceil(span / HOUR_MS - EPSILON)), unit: "hour" as const };
  return { count: Math.ceil(span / DAY_MS - EPSILON), unit: "day" as const };
}

/**
 * "previous 24 hours" up to two days, otherwise whole days: "previous 7 days". A partial last
 * hour or day counts whole, so "Last 7 days" ending mid-day still reads as 7.
 */
export function previousPeriodLabel(range?: AnalyticsRange) {
  const length = periodLength(range);
  return length ? `previous ${plural(length.count, length.unit)}` : "previous period";
}

/** The same label in a few characters: "prior 7d", "prior 24h". */
export function priorPeriodLabel(range?: AnalyticsRange) {
  const length = periodLength(range);
  return length
    ? `prior ${length.count}${{ minute: "m", hour: "h", day: "d" }[length.unit]}`
    : "prior period";
}

const format = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0,
  }).format(Math.abs(value));

/**
 * Change against the previous period: "+30% vs previous 7 days". Rates pass `points` (the factor
 * that turns the value into percent) to show percentage points instead. The outcome says whether
 * the change is good, so measures where lower is better (durations) flip it. Without a previous
 * value there is no change to show, so it reads as a dash; so does a relative change from 0, but
 * a rate that rose from 0% has a change in points.
 */
export function growth(
  current: number | null | undefined,
  previous: number | null | undefined,
  options: { range?: AnalyticsRange; lowerIsBetter?: boolean; points?: number } = {},
): Growth {
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    (previous === 0 && options.points === undefined)
  )
    return { text: "—", short: "—", outcome: "none" };
  const change =
    options.points === undefined
      ? ((current - previous) / Math.abs(previous)) * 100
      : (current - previous) * options.points;
  const shown = format(change);
  const zero = Number(shown.replaceAll(",", "")) === 0;
  const sign = zero ? "" : change > 0 ? "+" : "−";
  const unit = options.points === undefined ? "%" : " pts";
  const outcome: GrowthOutcome = zero
    ? "neutral"
    : change > 0 !== !!options.lowerIsBetter
      ? "good"
      : "bad";
  const amount = `${sign}${shown}${unit}`;
  return {
    text: `${amount} vs ${previousPeriodLabel(options.range)}`,
    short: `${amount} vs ${priorPeriodLabel(options.range)}`,
    outcome,
  };
}
