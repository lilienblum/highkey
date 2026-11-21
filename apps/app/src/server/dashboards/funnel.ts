// Funnels: how many actors (or sessions) reach each step, in order, within a window of their
// first step. Compiled to ClickHouse's windowFunnel over the project's scoped `events` view.
import { predicate } from "../queries/events";
import { Params } from "../queries/properties";
import type { Rules } from "../queries/custom";
import type { GroupValue, RunOptions, Window } from "./metrics";
import { scoped } from "./metrics";
import type { FunnelQuery, Step } from "./spec";
import { rangeHours } from "./validate";

/** A step as a condition on one event row. */
export function stepCondition(step: Step, params: Params, rules?: Rules): string {
  return predicate(
    { event: step.event, source: null, identity_kind: null, filters: step.filters ?? [] } as never,
    params,
    rules,
  );
}

/** Each step's label: its event name, with its 1-based position when names repeat. */
export function stepLabels(steps: Step[]): string[] {
  const names = steps.map((s) => s.event);
  return names.map((name, i) =>
    names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} (${i + 1})`,
  );
}

/** One group per step, in step order: how many reached at least that step. */
export async function measureFunnel(
  q: FunnelQuery,
  w: Window,
  run: RunOptions,
): Promise<GroupValue[]> {
  const params = new Params();
  const conditions = q.steps.map((step) => stepCondition(step, params, run.rules));
  const windowMs = (rangeHours(q.window) ?? 168) * 3_600_000;
  const key =
    q.by === "group"
      ? `groups[${params.add("String", q.group_type ?? "")}]`
      : q.by === "session"
        ? "source_id, ifNull(identity_kind, ''), actor_id, session_id"
        : "ifNull(identity_kind, ''), actor_id";
  const present =
    q.by === "group"
      ? `${key}!=''`
      : q.by === "session"
        ? "actor_id IS NOT NULL AND session_id IS NOT NULL"
        : "actor_id IS NOT NULL";
  const sql = `SELECT level, count() AS n FROM (SELECT windowFunnel(${windowMs})(toUInt64(toUnixTimestamp64Milli(event_time)), ${conditions.join(", ")}) AS level FROM events WHERE ${present} AND ((${conditions.join(") OR (")})) GROUP BY ${key}) WHERE level > 0 GROUP BY level`;
  const result = await run.reader.query<{ level: number; n: number }>(
    sql,
    scoped(w, q.source_id ?? run.source, run, params.values),
  );
  const reached = new Map(result.data.map((row) => [Number(row.level), Number(row.n)]));
  return stepLabels(q.steps).map((label, i) => {
    let value = 0;
    for (const [level, n] of reached) if (level >= i + 1) value += n;
    return { label, value };
  });
}
