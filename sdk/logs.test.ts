import { test, expect } from "bun:test";
import { attributeValue, validateLogsSearch } from "../apps/dashboard/src/lib/logs";
import { appendLogPage, MAX_BUFFERED_LOGS } from "../apps/dashboard/src/lib/log-buffer";
import type { LogResult, LogRow } from "../apps/dashboard/src/lib/logs";
test("log URL filters preserve scalar types and reject invalid cursors and ranges", () => {
  expect(attributeValue("200", "number")).toBe(200);
  expect(attributeValue("200", "string")).toBe("200");
  expect(attributeValue("false", "boolean")).toBe(false);
  expect(() => attributeValue("NaN", "number")).toThrow();
  expect(() => attributeValue("yes", "boolean")).toThrow();
  expect(
    validateLogsSearch({
      logq: "timeout",
      level: "error",
      attribute: "status",
      attributeType: "number",
      attributeValue: "500",
    }),
  ).toMatchObject({ logq: "timeout", level: "error", attributeValue: "500" });
  for (const value of [
    { level: "unknown" },
    { logWindow: "forever" },
    { attribute: "status", attributeType: "number", attributeValue: "NaN" },
    { logBefore: { timestamp: 0, log_id: "bad id" } },
    { logFrom: "2026-01-01T00:00:00.000Z", logTo: "2026-03-01T00:00:00.000Z" },
  ])
    expect(validateLogsSearch(value)).toEqual({ invalidLogs: true });
});

test("older log buffers deduplicate records, retain typed data, and never skip clipped rows", () => {
  const cap = MAX_BUFFERED_LOGS;
  const base = cap * 2;
  const row = (i: number): LogRow => ({
    log_id: `log-${i}`,
    timestamp: base - i,
    received_at: 10_000,
    source_id: "source",
    level: "info",
    message: `Record ${i}`,
    service: "api",
    environment: null,
    trace_id: null,
    span_id: null,
    request_id: null,
    attributes: { cached: false, status: 200 },
  });
  const result = (logs: LogRow[], next = true): LogResult => ({
    logs,
    total: cap * 2,
    series: [],
    services: [],
    next_cursor:
      next && logs.length
        ? { timestamp: logs[logs.length - 1].timestamp, log_id: logs[logs.length - 1].log_id }
        : null,
  });
  const head = result(Array.from({ length: cap - 5 }, (_, i) => row(i)));
  const page = result(Array.from({ length: 100 }, (_, i) => row(cap - 6 + i)));
  const combined = appendLogPage(head, page);
  expect(combined.logs).toHaveLength(MAX_BUFFERED_LOGS);
  expect(new Set(combined.logs.map((log) => log.log_id)).size).toBe(MAX_BUFFERED_LOGS);
  expect(combined.logs.at(-1)).toEqual(row(cap - 1));
  expect(combined.next_cursor).toEqual({ timestamp: base - (cap - 1), log_id: `log-${cap - 1}` });
  expect(combined.logs[cap - 5].attributes).toEqual({ cached: false, status: 200 });
  expect(appendLogPage(result([row(0)]), result([row(0)])).next_cursor).toBeNull();
  expect(appendLogPage(result([row(0)]), result([], false)).next_cursor).toBeNull();
});
