// Reading typed JSON properties (events) and attributes (logs) in ClickHouse SQL. Values keep
// their JSON type: a number filter matches only numbers, a string filter only strings.
import type { Bucket } from "../clickhouse/access";
import { bad } from "../api/errors";

const KEY = /^[A-Za-z0-9_\-./]{1,64}$/;

export function validKey(key: string): boolean {
  return KEY.test(key);
}

/** The ClickHouse path of a JSON key. Dots are stored escaped, so `a.b` is one key. */
export function path(column: "properties" | "attributes", key: string): string {
  if (!validKey(key)) throw bad("Invalid property key");
  return `${column}.\`${key.replaceAll(".", "%2E")}\``;
}

/** A JSON value as Float64 when it is a number, else NULL. */
export function numeric(expression: string): string {
  const as = (type: string) => `dynamicElement(${expression}, '${type}')`;
  return `multiIf(dynamicType(${expression}) = 'Int64', toFloat64(${as("Int64")}), dynamicType(${expression}) = 'UInt64', toFloat64(${as("UInt64")}), dynamicType(${expression}) = 'Float64', ${as("Float64")}, NULL)`;
}

/** Bound parameters collected while building a query. */
export class Params {
  readonly values: Record<string, string | number | boolean | null> = {};
  private next = 0;

  add(type: string, value: string | number | boolean | null): string {
    const name = `p${this.next++}`;
    this.values[name] = value;
    return `{${name}:${type}}`;
  }
}

/** A JSON value equal to a scalar of the same JSON type. */
export function scalarEquals(expression: string, value: unknown, params: Params): string {
  if (typeof value === "boolean")
    return `(dynamicType(${expression}) = 'Bool' AND dynamicElement(${expression}, 'Bool') = ${params.add("Bool", value)})`;
  if (typeof value === "string")
    return `(dynamicType(${expression}) = 'String' AND dynamicElement(${expression}, 'String') = ${params.add("String", value)})`;
  if (typeof value === "number")
    return `(${numeric(expression)} = ${params.add("Float64", value)})`;
  throw bad("Ordered comparisons require numbers; eq/ne require scalar values");
}

const ORDERED: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * One filter on a typed JSON value. A negated op (ne, not_in, not_contains) never matches an
 * absent value, and every op but exists and not_exists compares within one JSON type.
 */
export function filterCondition(
  expression: string,
  op: string | null | undefined,
  value: unknown,
  params: Params,
): string {
  const present = `dynamicType(${expression}) != 'None'`;
  switch (op ?? "eq") {
    case "exists":
      return `(${present})`;
    case "not_exists":
      return `(dynamicType(${expression}) = 'None')`;
    case "eq":
      return scalarEquals(expression, value, params);
    case "ne":
      return typeof value === "number"
        ? `(${numeric(expression)} != ${params.add("Float64", value)})`
        : `(${present} AND NOT ${scalarEquals(expression, value, params)})`;
    case "in":
    case "not_in": {
      if (!Array.isArray(value) || value.length === 0) throw bad("in and not_in need a list");
      const any = `(${value.map((v) => scalarEquals(expression, v, params)).join(" OR ")})`;
      return op === "in" ? any : `(${present} AND NOT coalesce(${any}, false))`;
    }
    case "contains":
    case "not_contains": {
      if (typeof value !== "string") throw bad("contains and not_contains need text");
      const at = `positionCaseInsensitiveUTF8(dynamicElement(${expression}, 'String'), ${params.add("String", value)})`;
      return `(dynamicType(${expression}) = 'String' AND ${at} ${op === "contains" ? "> 0" : "= 0"})`;
    }
    default: {
      const ordered = ORDERED[op as string];
      if (!ordered) throw bad("Unknown filter op");
      if (typeof value !== "number")
        throw bad("Ordered comparisons require numbers; eq/ne require scalar values");
      return `(${numeric(expression)} ${ordered} ${params.add("Float64", value)})`;
    }
  }
}

/** A distinct count of present values, telling 1 and "1" apart. */
export function distinctValues(expression: string): string {
  return `uniqExactIf((dynamicType(${expression}), toString(${expression})), dynamicType(${expression}) != 'None')`;
}

/** Reads a typed JSON value from a `dynamicType`/`toString` pair in a result row. */
export function typedValue(type: string, text: string | null): unknown {
  if (text === null || type === "None") return null;
  if (type === "Int64" || type === "UInt64" || type === "Float64") return Number(text);
  if (type === "Bool") return text === "true";
  if (type === "String") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The start of each UTC bucket from the one containing `from` up to `to`. Weeks start Monday. */
export function bucketGrid(from: Date, to: Date, bucket: Bucket): number[] {
  const start = new Date(from.getTime());
  if (bucket === "hour") start.setUTCMinutes(0, 0, 0);
  else {
    start.setUTCHours(0, 0, 0, 0);
    if (bucket === "week") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    if (bucket === "month") start.setUTCDate(1);
  }
  const times: number[] = [];
  for (const time = start; time.getTime() < to.getTime(); ) {
    times.push(time.getTime());
    if (bucket === "hour") time.setUTCHours(time.getUTCHours() + 1);
    else if (bucket === "day") time.setUTCDate(time.getUTCDate() + 1);
    else if (bucket === "week") time.setUTCDate(time.getUTCDate() + 7);
    else time.setUTCMonth(time.getUTCMonth() + 1);
  }
  return times;
}
