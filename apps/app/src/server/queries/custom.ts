import { fields } from "../api/body";
import { bad } from "../api/errors";
import { all, type Db } from "../db/db";
import type { CustomClause } from "../../lib/event-catalog";
import { filterCondition, Params, path, validKey } from "./properties";
import { supportedOp, unaryFilter } from "../../lib/filter-ops";
export type Rules = Map<string, CustomClause[]>;
export const validEvent = (name: string) => validKey(name.startsWith("@") ? name.slice(1) : name);
export function parseRules(input: unknown): CustomClause[] {
  if (
    !Array.isArray(input) ||
    input.length > 8 ||
    new TextEncoder().encode(JSON.stringify(input)).length > 4096
  )
    throw bad("Use up to eight alternatives and 4 KiB per definition");
  return input.map((v) => {
    const rule = fields(v, { event: "string", filters: "unknown" }, { filters: [] });
    if (!validKey(rule.event) || !Array.isArray(rule.filters) || rule.filters.length > 8)
      throw bad("Each alternative needs a raw event name and up to eight property filters");
    return {
      event: rule.event,
      filters: rule.filters.map((f) => {
        const { property, op, value } = fields(f, {
          property: "string",
          op: "string",
          value: "unknown",
        });
        if (
          !supportedOp(op) ||
          (unaryFilter(op) && value !== undefined) ||
          (value !== undefined && !["string", "boolean", "number"].includes(typeof value)) ||
          (typeof value === "string" && value.length > 512)
        )
          throw bad("Invalid custom event filter");
        filterCondition(path("properties", property), op, value, new Params());
        return { property, op, value: value as string | number | boolean | undefined };
      }),
    };
  });
}
export async function customRules(db: Db, id: string): Promise<Rules> {
  return new Map(
    (
      await all<{ name: string; rules: string }>(
        db,
        "SELECT name,rules FROM event_catalog WHERE product_id=? AND rules!='[]'",
        [id],
      )
    ).map((r) => [r.name, JSON.parse(r.rules) as CustomClause[]]),
  );
}
export function namedEvent(name: string, params: Params, rules?: Rules): string {
  if (!name.startsWith("@")) return `name = ${params.add("String", name)}`;
  const clauses = rules?.get(name);
  if (!clauses?.length) throw bad(`Unknown custom event: ${name}`);
  return `(${clauses.map((c) => `(name=${params.add("String", c.event)}${c.filters.map((f) => ` AND ${filterCondition(path("properties", f.property), f.op, f.value, params)}`).join("")})`).join(" OR ")})`;
}
/** An event that matches several goals is still one conversion. */
export function anyNamedEvent(names: string[], params: Params, rules?: Rules): string {
  const raw = names.filter((n) => !n.startsWith("@"));
  const alternatives = names
    .filter((n) => n.startsWith("@"))
    .map((n) => namedEvent(n, params, rules));
  if (raw.length) alternatives.push(`name IN ${params.addList(raw)}`);
  return alternatives.length ? `(${alternatives.join(" OR ")})` : "0";
}
