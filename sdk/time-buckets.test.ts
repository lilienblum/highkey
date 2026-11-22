import { describe, expect, test } from "bun:test";
import {
  automaticBucket,
  bucketStart,
  nextBucket,
  partialBucketNote,
  timeAxisTicks,
} from "../apps/app/src/lib/time-buckets";
const time = Date.parse;

describe("UTC chart calendar buckets", () => {
  test("weeks start Monday across year boundaries", () => {
    expect(bucketStart(time("2027-01-03T12:00:00Z"), "week")).toBe(time("2026-12-28T00:00:00Z"));
    expect(nextBucket(time("2027-01-03T12:00:00Z"), "week")).toBe(time("2027-01-04T00:00:00Z"));
  });
  test("months use calendar lengths, including leap February", () => {
    for (const [input, expected] of [
      ["2024-02-29", "2024-03-01"],
      ["2025-02-28", "2025-03-01"],
      ["2026-12-31", "2027-01-01"],
    ]) {
      expect(nextBucket(time(`${input}T12:00:00Z`), "month")).toBe(time(`${expected}T00:00:00Z`));
    }
  });
  test("exact exclusive boundaries are complete, partial boundaries are labelled", () => {
    expect(
      partialBucketNote({ from: "2024-02-01T00:00:00Z", to: "2024-03-01T00:00:00Z" }, "month"),
    ).toBe("Complete UTC months.");
    expect(
      partialBucketNote({ from: "2024-02-14T00:00:00Z", to: "2024-02-29T12:00:00Z" }, "month"),
    ).toBe("First and last months are partial.");
    expect(
      partialBucketNote({ from: "2026-11-02T00:00:00Z", to: "2026-11-09T01:00:00Z" }, "week"),
    ).toBe("Last week is partial.");
  });
  test("hours and days stay in UTC across daylight-saving dates", () => {
    expect(nextBucket(time("2026-11-01T23:30:00Z"), "day")).toBe(time("2026-11-02T00:00:00Z"));
    expect(nextBucket(time("2026-11-01T23:30:00Z"), "hour")).toBe(time("2026-11-02T00:00:00Z"));
  });
});

test("chart detail follows the selected range at each boundary", () => {
  const from = "2026-01-01T00:00:00.000Z";
  for (const [days, expected] of [
    [1 / 24, "minute"],
    [(3600000 + 1) / 86400000, "hour"],
    [1, "hour"],
    [2, "hour"],
    [2 + 1 / 86400000, "day"],
    [7, "day"],
    [30, "day"],
    [31, "day"],
    [90, "day"],
    [180, "day"],
    [366, "day"],
  ] as const) {
    const to = new Date(Date.parse(from) + days * 86400000).toISOString();
    expect(automaticBucket({ from, to })).toBe(expected);
  }
});

test("a leap year keeps daily detail with calendar labels that fit the plot", () => {
  const days = Array.from({ length: 366 }, (_, i) => ({ time: Date.UTC(2024, 0, 1 + i) }));
  const wide = timeAxisTicks(days, "day", 1200);
  expect(wide.labelBucket).toBe("month");
  expect(wide.values).toEqual(Array.from({ length: 12 }, (_, m) => Date.UTC(2024, m, 1)));
  expect(timeAxisTicks(days, "day", 390).values).toEqual(
    [0, 3, 6, 9].map((m) => Date.UTC(2024, m, 1)),
  );
});
