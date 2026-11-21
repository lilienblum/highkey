// Retention: actors grouped into cohorts by the period of their first start event in the range,
// and the share of each cohort that sent a return event in each following period. Compiled to
// ClickHouse's retention() over the project's scoped `events` view.
import { Params } from "../queries/properties";
import { stepCondition } from "./funnel";
import type { RunOptions, Window } from "./metrics";
import { scoped } from "./metrics";
import type { Period, RetentionQuery } from "./spec";

const START: Record<Period, string> = {
  day: "toDate(event_time)",
  week: "toMonday(event_time)",
  month: "toStartOfMonth(event_time)",
};
const ADD: Record<Period, string> = { day: "addDays", week: "addWeeks", month: "addMonths" };

/** The start of the period `k` periods after `cohort` (epoch ms, UTC). */
export function periodStart(cohort: number, period: Period, k: number): number {
  if (period === "day") return cohort + k * 86_400_000;
  if (period === "week") return cohort + k * 7 * 86_400_000;
  const at = new Date(cohort);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + k, 1);
}

/** A table column; `unit` (such as `ratio` for shares from 0 to 1) tells the table how to show it. */
export interface Column {
  name: string;
  type: string;
  unit?: "ratio";
}

export interface Table {
  columns: Column[];
  rows: unknown[][];
}

export async function measureRetention(
  q: RetentionQuery,
  w: Window,
  run: RunOptions,
): Promise<Table> {
  const params = new Params();
  const start = stepCondition(q.start, params, run.rules);
  const back = stepCondition(q.return, params, run.rules);
  const of = START[q.period];
  const conditions = [`${of} = c.cohort AND (${start})`];
  for (let k = 1; k <= q.periods; k++)
    conditions.push(`${of} = ${ADD[q.period]}(c.cohort, ${k}) AND (${back})`);
  const sql = `WITH cohorts AS (SELECT ifNull(identity_kind, '') AS kind, actor_id AS actor, ${of.replace("event_time", "min(event_time)")} AS cohort FROM events WHERE actor_id IS NOT NULL AND (${start}) GROUP BY kind, actor) SELECT toUnixTimestamp(toDateTime(cohort, 'UTC')) * 1000 AS cohort, count() AS size, sumForEach(r) AS returned FROM (SELECT c.cohort AS cohort, retention(${conditions.join(", ")}) AS r FROM events INNER JOIN cohorts AS c ON ifNull(identity_kind, '') = c.kind AND actor_id = c.actor WHERE (${start}) OR (${back}) GROUP BY c.kind, c.actor, c.cohort) GROUP BY cohort ORDER BY cohort`;
  const result = await run.reader.query<{ cohort: number; size: number; returned: number[] }>(
    sql,
    scoped(w, q.source_id ?? run.source, run, params.values),
  );
  const end = w.to.getTime();
  // A cohort is a UTC calendar period, so it is a date wherever the viewer is.
  const columns: Column[] = [
    { name: "cohort", type: "Date" },
    { name: "size", type: "UInt64" },
  ];
  for (let k = 0; k <= q.periods; k++)
    columns.push({ name: `p${k}`, type: "Float64", unit: "ratio" });
  const rows = result.data.map((row) => {
    const cohort = Number(row.cohort);
    const size = Number(row.size);
    const shares = Array.from({ length: q.periods + 1 }, (_, k) =>
      periodStart(cohort, q.period, k) >= end ? null : Number(row.returned[k] ?? 0) / size,
    );
    return [cohort, size, ...shares];
  });
  return { columns, rows };
}
