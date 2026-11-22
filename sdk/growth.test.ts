import { expect, test } from "bun:test";
import {
  growth,
  previousPeriodLabel,
  previousRange,
  retainedComparison,
} from "../apps/app/src/lib/growth";

const DAY = 86_400_000;
const hours = (n: number) => ({
  from: "2026-11-01T00:00:00.000Z",
  to: new Date(Date.UTC(2026, 10, 1) + n * 3_600_000).toISOString(),
});
const range = (days: number) => ({
  from: new Date(Date.UTC(2026, 10, 1)).toISOString(),
  to: new Date(Date.UTC(2026, 10, 1) + days * DAY).toISOString(),
});

test("growth is signed, rounded and worded against the previous period", () => {
  const week = { range: range(7) };
  expect(growth(130, 100, week)).toEqual({
    text: "+30% vs previous 7 days",
    short: "+30% vs prior 7d",
    outcome: "good",
  });
  expect(growth(70, 100, week)).toEqual({
    text: "−30% vs previous 7 days",
    short: "−30% vs prior 7d",
    outcome: "bad",
  });
  expect(growth(100, 100, week)).toEqual({
    text: "0% vs previous 7 days",
    short: "0% vs prior 7d",
    outcome: "neutral",
  });
});

test("small changes keep one decimal and large ones are whole numbers", () => {
  expect(growth(104.54, 100).text).toStartWith("+4.5%");
  expect(growth(103, 100).text).toStartWith("+3%");
  expect(growth(100.04, 100).text).toStartWith("0%");
  expect(growth(1234, 1000).text).toStartWith("+23%");
  expect(growth(300, 100).text).toStartWith("+200%");
  expect(growth(9.96 + 100, 100).text).toStartWith("+10%");
});

test("lower-is-better measures invert the outcome, not the sign", () => {
  const faster = growth(80, 100, { lowerIsBetter: true, range: range(7) });
  expect(faster).toEqual({
    text: "−20% vs previous 7 days",
    short: "−20% vs prior 7d",
    outcome: "good",
  });
  expect(growth(120, 100, { lowerIsBetter: true }).outcome).toBe("bad");
  expect(growth(100, 100, { lowerIsBetter: true }).outcome).toBe("neutral");
});

test("a zero or missing baseline shows a dash with no outcome", () => {
  const dash = { text: "—", short: "—", outcome: "none" as const };
  expect(growth(5, 0)).toEqual(dash);
  expect(growth(0, 0)).toEqual(dash);
  expect(growth(5, null)).toEqual(dash);
  expect(growth(5, undefined)).toEqual(dash);
  expect(growth(null, 5)).toEqual(dash);
  expect(growth(Number.NaN, 5)).toEqual(dash);
});

test("rates change in percentage points", () => {
  expect(growth(52.1, 50, { points: 1, range: range(30) })).toEqual({
    text: "+2.1 pts vs previous 30 days",
    short: "+2.1 pts vs prior 30d",
    outcome: "good",
  });
  expect(growth(0.4, 0.5, { points: 100 }).text).toStartWith("−10 pts");
  // A rate that rose from 0% changed by points, even though no percentage change exists.
  expect(growth(5, 0, { points: 1, range: range(7) })).toEqual({
    text: "+5 pts vs previous 7 days",
    short: "+5 pts vs prior 7d",
    outcome: "good",
  });
  expect(growth(0, 0, { points: 1 }).outcome).toBe("neutral");
  expect(growth(5, null, { points: 1 }).text).toBe("—");
});

test("the label names the length of the range", () => {
  expect(previousPeriodLabel(range(7))).toBe("previous 7 days");
  expect(previousPeriodLabel(range(1))).toBe("previous 24 hours");
  expect(previousPeriodLabel(range(2))).toBe("previous 48 hours");
  expect(previousPeriodLabel(range(30))).toBe("previous 30 days");
  expect(previousPeriodLabel(range(366))).toBe("previous 366 days");
  expect(previousPeriodLabel(hours(1))).toBe("previous 1 hour");
  expect(previousPeriodLabel(hours(5.4))).toBe("previous 6 hours");
  // A partial period such as month to date or the last 7 calendar days counts its last day whole.
  expect(
    previousPeriodLabel({ ...range(0), to: new Date(Date.UTC(2026, 10, 15, 8)).toISOString() }),
  ).toBe("previous 15 days");
  expect(growth(2, 1).text).toBe("+100% vs previous period");
  expect(growth(2, 1).short).toBe("+100% vs prior period");
  expect(growth(2, 1, { range: range(1) }).short).toBe("+100% vs prior 24h");
  expect(growth(2, 1, { range: range(30) }).short).toBe("+100% vs prior 30d");
  expect(growth(2, 1, { range: hours(5.4) }).short).toBe("+100% vs prior 6h");
});

test("the previous window is the equal span just before the range", () => {
  const current = range(7);
  expect(previousRange(current)).toEqual({
    from: new Date(Date.UTC(2026, 10, 1) - 7 * DAY).toISOString(),
    to: current.from,
  });
});

test("comparison gaps distinguish expired history from measured zero", () => {
  const current = range(2);
  const start = Date.parse(current.from);
  const points = [
    { time: start, value: 2 },
    { time: start + DAY, value: 0 },
  ];
  expect(retainedComparison(points, current, start - DAY)).toEqual([points[1]]);
  expect(retainedComparison(points, current, start)).toBeUndefined();
});
