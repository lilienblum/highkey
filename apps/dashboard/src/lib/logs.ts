import { validDate, validKey } from "./workspace-search";
export const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof logLevels)[number];
export const logWindows = {
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
} as const;
export type LogRow = {
  log_id: string;
  source_id: string;
  timestamp: number;
  received_at: number;
  level: LogLevel;
  message: string;
  service: string;
  environment: string | null;
  trace_id: string | null;
  span_id: string | null;
  request_id: string | null;
  attributes: Record<string, unknown>;
};
export type LogCursor = { timestamp: number; log_id: string };
/** Values known in the selected window and source, independent of the other filters. */
export type LogFacets = {
  services: { name: string; count: number }[];
  environments: { name: string; count: number }[];
  attributes: { key: string; type: "string" | "number" | "boolean"; count: number }[];
};
export type LogResult = {
  logs: LogRow[];
  next_cursor: LogCursor | null;
  total: number;
  series: { time: number; count: number; errors: number }[];
  services: { name: string; count: number }[];
  /** Present on the first page of a query; older pages keep the first page's facets. */
  facets?: LogFacets | null;
};
export type LogsSearch = {
  logq?: string;
  level?: LogLevel;
  service?: string;
  environment?: string;
  trace?: string;
  logWindow?: keyof typeof logWindows;
  attribute?: string;
  attributeValue?: string;
  attributeType?: "string" | "number" | "boolean";
  logBefore?: LogCursor;
  logFrom?: string;
  logTo?: string;
  invalidLogs?: true;
};
export function attributeValue(value: string, type: string): string | number | boolean {
  if (type === "number") {
    if (!value.trim() || !Number.isFinite(Number(value)))
      throw new Error("Enter a finite number for the attribute value.");
    return Number(value);
  }
  if (type === "boolean") {
    if (!["true", "false"].includes(value))
      throw new Error("Enter true or false for the attribute value.");
    return value === "true";
  }
  return value;
}
export function validateLogsSearch(s: Record<string, unknown>): LogsSearch {
  const text = (key: string, max: number) =>
    s[key] === undefined || (typeof s[key] === "string" && (s[key] as string).length <= max);
  const cursor = s.logBefore as Partial<LogCursor> | undefined;
  let invalid =
    !text("logq", 512) ||
    !text("service", 128) ||
    !text("environment", 128) ||
    !text("trace", 128) ||
    !text("attribute", 128) ||
    !text("attributeValue", 512) ||
    (s.level !== undefined && !logLevels.includes(s.level as LogLevel)) ||
    (s.logWindow !== undefined && !Object.hasOwn(logWindows, String(s.logWindow))) ||
    (s.attributeType !== undefined &&
      !["string", "number", "boolean"].includes(String(s.attributeType))) ||
    (cursor !== undefined &&
      (!cursor ||
        typeof cursor !== "object" ||
        !validKey(cursor.log_id) ||
        !Number.isSafeInteger(cursor.timestamp))) ||
    ((s.logFrom !== undefined || s.logTo !== undefined) &&
      (!validDate(s.logFrom) ||
        !validDate(s.logTo) ||
        Date.parse(s.logTo) <= Date.parse(s.logFrom) ||
        Date.parse(s.logTo) - Date.parse(s.logFrom) > 31 * 86_400_000));
  try {
    if (s.attribute)
      attributeValue(String(s.attributeValue ?? ""), String(s.attributeType ?? "string"));
  } catch {
    invalid = true;
  }
  if (invalid || s.invalidLogs) return { invalidLogs: true };
  return {
    logq: s.logq as string | undefined,
    level: s.level as LogLevel | undefined,
    service: s.service as string | undefined,
    environment: s.environment as string | undefined,
    trace: s.trace as string | undefined,
    logWindow: s.logWindow as LogsSearch["logWindow"],
    attribute: s.attribute as string | undefined,
    attributeValue: s.attributeValue as string | undefined,
    attributeType: s.attributeType as LogsSearch["attributeType"],
    logBefore: cursor as LogCursor | undefined,
    logFrom: s.logFrom as string | undefined,
    logTo: s.logTo as string | undefined,
  };
}
