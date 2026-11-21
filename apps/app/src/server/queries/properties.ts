// Reading typed JSON properties (events) and attributes (logs) in ClickHouse SQL. Values keep
// their JSON type: a number filter matches only numbers, a string filter only strings.
import type { Bucket } from "../clickhouse/access";
import { bad } from "../api/errors";
import { contextColumn } from "../../lib/event-context";
import { validRegex } from "../../lib/filter-ops";
import { sessionFields } from "../../lib/session-fields";
import { bucketStart, nextBucket } from "../../lib/time-buckets";

const KEY = /^[A-Za-z0-9_\-./]{1,64}$/;

export function validKey(key: string): boolean {
  return KEY.test(key);
}

/** The ClickHouse path of a JSON key. Dots are stored escaped, so `a.b` is one key. */
export function path(column: "properties" | "attributes", key: string): string {
  if (!validKey(key)) throw bad("Invalid property key");
  const derived = column === "properties" ? contextColumn(key) : undefined;
  if (derived) return `CAST(nullIf(CAST(${derived} AS String),''),'Dynamic')`;
  if (column === "properties") {
    if (key === "outbound.url")
      return "CAST(if(name='link_out',properties.url.:String,NULL),'Dynamic')";
    if (key === "page.entry" || key === "page.exit") {
      const pick = key === "page.entry" ? "argMin" : "argMax";
      return `CAST(if(event_id IN (SELECT ${pick}(event_id,tuple(event_time,event_id)) FROM all_events WHERE identity_kind='visitor' AND actor_id IS NOT NULL AND session_id IS NOT NULL AND name='page_view' AND NOT backfill GROUP BY source_id,actor_id,session_id),properties.path.:String,NULL),'Dynamic')`;
    }
    if (key === "event.id") return "CAST(event_id,'Dynamic')";
    if (/^cohort\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(key))
      return `CAST(toBool(event_id IN (SELECT event_id FROM profile_events WHERE profile_id IN (SELECT profile_id FROM cohort_members WHERE cohort_id=toUUID('${key.slice(7)}')))),'Dynamic')`;
    if (key === "profile.id" || key === "session.id")
      return `CAST(${key === "profile.id" ? "profile_id" : "session_id"},'Dynamic')`;
    if (key.startsWith("group.") && validKey(key.slice(6)))
      return `CAST(nullIf(groups['${key.slice(6)}'],''),'Dynamic')`;
  }
  return `${column}.\`${key.replaceAll(".", "%2E")}\``;
}

/** A JSON value as Float64 when it is a number, else NULL. */
export function numeric(expression: string): string {
  const as = (type: string) => `dynamicElement(${expression}, '${type}')`;
  return `multiIf(dynamicType(${expression}) = 'Int64', toFloat64(${as("Int64")}), dynamicType(${expression}) = 'UInt64', toFloat64(${as("UInt64")}), dynamicType(${expression}) = 'Float64', ${as("Float64")}, NULL)`;
}

/** Bound parameters collected while building a query. */
export class Params {
  readonly values: Record<string, string | number | boolean | null | readonly string[]> = {};
  private next = 0;
  addList(values: readonly string[]): string {
    const name = `p${this.next++}`;
    this.values[name] = values;
    return `{${name}:Array(String)}`;
  }

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

/** Use a semi-join for entity and whole-visit fields; ordinary predicates stay on the event view. */
export function eventFilter(f: { property: string; op: string; value?: unknown }, p: Params) {
  const { property: key, op, value } = f;
  if (!validKey(key)) throw bad("Invalid property key");
  const [kind, field, ...suffix] = key.split(".");
  const missing = op === "not_exists" || op === "empty";
  const match = (expr: string) => filterCondition(expr, op, value, p);
  // NOT IN the entities failing the comparison also includes events without a related entity.
  const members = (outer: string, inner: string, table: string, expr: string) =>
    `${outer} ${missing ? "NOT IN" : "IN"} (SELECT ${inner} FROM ${table} WHERE ${missing ? "NOT" : ""} (${match(expr)}))`;
  if (kind === "session" && sessionFields.some((v) => v === field) && !suffix.length) {
    const expr =
      field === "revenue_cents"
        ? "toFloat64(revenue_cents)"
        : field === "bounced"
          ? "toBool(bounced)"
          : field;
    return members(
      "tuple(source_id,ifNull(actor_id,''),ifNull(session_id,''))",
      "source_id,actor_id,session_id",
      "visit_fields",
      `CAST(${expr},'Dynamic')`,
    );
  }
  const group = kind === "group" && suffix.length > 0;
  if ((kind === "profile" && field && field !== "id") || group) {
    const trait = group ? suffix.join(".") : key.slice(8);
    const groupType = group ? p.add("String", field) : "";
    const table = group ? "group_records" : "profile_records",
      id = group ? "group_id" : "profile_id";
    const relation = `(SELECT first.1 AS entity_id,arrayFold((m,row)->highkey_apply_traits(m,row.3,row.4),arraySort(row->(row.1,row.2),groupArray(tuple(first.2,event_id,first.3,first.4))),CAST(map(),'Map(String,String)')) AS vals
    FROM (SELECT event_id,argMin(tuple(${id},event_time,toJSONString(traits),toJSONString(increments)),received_at) AS first FROM ${table} ${group ? `WHERE group_type=${groupType}` : ""} GROUP BY event_id) GROUP BY entity_id)`;
    const test = members(
      group ? `groups[${groupType}]` : "ifNull(profile_id,'')",
      "entity_id",
      relation,
      `JSONExtract(ifNull(nullIf(vals[${p.add("String", trait)}],''),'null'),'Dynamic')`,
    );
    return group ? test : `event_id IN (SELECT event_id FROM profile_events WHERE ${test})`;
  }
  return match(path("properties", key));
}

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
    case "empty":
    case "not_empty": {
      const empty = `(NOT (${present}) OR (dynamicType(${expression})='String' AND dynamicElement(${expression},'String')=''))`;
      return op === "empty" ? empty : `NOT ${empty}`;
    }
    case "regex":
      if (typeof value !== "string" || !validRegex(value))
        throw bad(
          "Use a regular expression of up to 256 bytes without lookaround or backreferences",
        );
      return `(dynamicType(${expression})='String' AND match(dynamicElement(${expression},'String'),${params.add("String", value)}))`;
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
    case "starts_with":
    case "ends_with": {
      if (typeof value !== "string") throw bad("Prefix and suffix filters need text");
      return `(dynamicType(${expression})='String' AND ${op === "starts_with" ? "startsWith" : "endsWith"}(dynamicElement(${expression},'String'),${params.add("String", value)}))`;
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
  const times: number[] = [];
  for (let t = bucketStart(+from, bucket); t < +to; t = nextBucket(t, bucket)) times.push(t);
  return times;
}
