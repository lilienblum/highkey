import type { ApiContext } from "../api/context";
import { bad } from "../api/errors";
import { fields } from "../api/body";
import { requireSource } from "../db/sources";
import { runSettings, SOURCE_SCOPE } from "../clickhouse/access";
import { parseEventsQuery, predicate, parseFilters } from "./events";
import { anyNamedEvent, customRules, namedEvent, validEvent } from "./custom";
import { bucketGrid, Params, path, validKey } from "./properties";
import { readAs } from "./read";
import { periodStart } from "../dashboards/retention";
import { eventFilter } from "./properties";

export function analysisSpec(input: unknown) {
  const q = fields(
    input,
    {
      mode: "string",
      steps: "string[]",
      returns: "string[]",
      period: "string",
      periods: "integer",
      after: "boolean",
      by: "string",
      group_type: "string",
      breakdown: "string",
      at_step: "integer",
      window_hours: "integer",
      filters: "unknown",
    },
    {
      steps: [],
      returns: [],
      period: "day",
      periods: 8,
      after: false,
      by: "actor",
      group_type: "",
      breakdown: "",
      at_step: 1,
      window_hours: 168,
    },
  );
  if (
    !["conversion", "retention", "funnel", "breakdown"].includes(q.mode) ||
    !["day", "week", "month"].includes(q.period) ||
    q.periods < 1 ||
    q.periods > 12 ||
    q.steps.length > 8 ||
    q.returns.length > 8 ||
    ![...q.steps, ...q.returns].every(validEvent) ||
    (q.mode === "funnel" && q.steps.length < 2) ||
    (q.mode === "conversion" && q.steps.length !== 2) ||
    (q.mode === "retention" && (!q.steps.length || !q.returns.length)) ||
    !["actor", "group", "session"].includes(q.by) ||
    (q.by === "group" && !validKey(q.group_type)) ||
    (q.breakdown && !validKey(q.breakdown)) ||
    q.at_step < 1 ||
    q.at_step > Math.max(1, q.steps.length) ||
    q.window_hours < 1 ||
    q.window_hours > 8760
  )
    throw bad(
      "Invalid analysis definition: choose valid events, period, counting unit, and a bounded conversion window",
    );
  const filters = parseFilters(q.filters);
  if (filters.length > 8) throw bad("Use up to eight filters");
  for (const f of filters) eventFilter(f, new Params());
  return { ...q, period: q.period as "day" | "week" | "month", filters };
}
export async function analysis(ctx: ApiContext, id: string, body: unknown) {
  const b = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      spec: "unknown",
      step: "integer",
      drop: "boolean",
      page: "integer",
    },
    { step: 0, drop: false, page: 1 },
  );
  const q = analysisSpec(b.spec),
    { from, to } = parseEventsQuery({ from: b.from, to: b.to });
  if (b.source_id) await requireSource(ctx.db, id, b.source_id);
  if (b.step < 0 || b.step > q.steps.length || b.page < 1 || b.page > 10000)
    throw bad("Invalid drilldown step or page");
  const rules = await customRules(ctx.db, id),
    p = new Params(),
    bounds = (f: Date, t: Date) => ({
      settings: runSettings({ from: f, to: t, source: b.source_id ?? null, bucket: q.period }),
      params: p.values,
    });
  const where = predicate({ filters: q.filters } as Parameters<typeof predicate>[0], p, rules);
  const firsts = anyNamedEvent(q.steps, p, rules),
    returns = anyNamedEvent(q.returns, p, rules);
  const dim = q.breakdown ? `toJSONString(${path("properties", q.breakdown)})` : "'null'";
  const span = +to - +from,
    prev = new Date(+from - span);
  return readAs(ctx, id, async (r) => {
    if (q.mode === "retention") {
      const k = "tuple(ifNull(identity_kind,''),assumeNotNull(actor_id))",
        of = "bucket(event_time)";
      const sql = `WITH origins AS (SELECT ${k} AS actor,min(${of}) AS cohort FROM events WHERE actor_id IS NOT NULL AND (${firsts}) AND ${where} GROUP BY actor),
      per_actor AS (SELECT c.actor,c.cohort,groupUniqArrayIf(dateDiff('${q.period}',c.cohort,${of}),(${returns})) AS ages FROM events e INNER JOIN origins c ON ${k}=c.actor WHERE (${firsts} OR ${returns}) AND ${where} GROUP BY c.actor,c.cohort)
      SELECT toUnixTimestamp64Milli(cohort) AS at,count() AS size,sumForEach(arrayMap(i->toUInt64(i=0 OR ${q.after ? "arrayExists(n->n>=i,ages)" : "has(ages,toInt64(i))"}),range(${q.periods + 1}))) AS counts FROM per_actor GROUP BY cohort ORDER BY cohort`;
      const rows = (
        await r.query<{ at: number; size: number; counts: number[] }>(sql, bounds(from, to))
      ).data.map((v) => ({
        ...v,
        counts: v.counts.map((n, i) =>
          periodStart(v.at, q.period, i) >= Math.min(+to, +ctx.now()) ? null : n,
        ),
      }));
      const curve = Array.from({ length: q.periods + 1 }, (_, i) => {
        let n = 0,
          size = 0;
        for (const row of rows)
          if (row.counts[i] != null) {
            n += row.counts[i]!;
            size += row.size;
          }
        return { n, size, rate: size ? n / size : null };
      });
      const activity = (
        await r.query<{ at: number; n: number }>(
          `SELECT toUnixTimestamp64Milli(${of}) AS at,uniqExact(${k}) AS n FROM events WHERE actor_id IS NOT NULL AND ${where} GROUP BY at ORDER BY at`,
          bounds(from, to),
        )
      ).data;
      const lastSeen = (
        await r.query<{ age: number; n: number }>(
          `SELECT multiIf(ageDays<7,0,ageDays<14,1,ageDays<30,2,ageDays<60,3,4) AS age,count() AS n FROM (SELECT intDiv(${+to}-toUnixTimestamp64Milli(max(event_time)),86400000) AS ageDays FROM all_events WHERE actor_id IS NOT NULL AND ${SOURCE_SCOPE} AND event_time<fromUnixTimestamp64Milli(${+to}) AND ${where} GROUP BY ${k}) GROUP BY age ORDER BY age`,
          bounds(from, to),
        )
      ).data;
      return { mode: "retention" as const, rows, curve, activity, lastSeen };
    }
    if (q.mode === "breakdown") {
      const { breakdownReport } = await import("./breakdowns");
      return {
        mode: "breakdown" as const,
        report: await breakdownReport(ctx, id, {
          from: b.from,
          to: b.to,
          source_id: b.source_id,
          dimension: q.breakdown ? `property:${q.breakdown}` : "name",
          event: q.steps[0],
          filters: q.filters,
          page: b.page,
        }),
      };
    }
    const steps = q.steps.map((n) => namedEvent(n, p, rules));
    const key =
      q.by === "group"
        ? `toJSONString(groups[${p.add("String", q.group_type)}])`
        : q.by === "session"
          ? "toJSONString(tuple(source_id,actor_id,session_id))"
          : "toJSONString(tuple(identity_kind,actor_id))";
    const known =
      q.by === "group"
        ? `${key}!='""'`
        : q.by === "session"
          ? "identity_kind='visitor' AND actor_id IS NOT NULL AND session_id IS NOT NULL"
          : "actor_id IS NOT NULL";
    if (q.mode === "conversion") {
      const window = async (f: Date, t: Date) =>
        (
          await r.query<{ at: number; label: string; entered: number; converted: number }>(
            `SELECT toUnixTimestamp64Milli(bin) AS at,label,count() AS entered,countIf(finish>start) AS converted FROM (
       SELECT bucket(event_time) AS bin,${key} AS who,argMinIf(${dim},tuple(event_time,event_id),(${steps[0]})) AS label,minIf(tuple(event_time,event_id),(${steps[0]})) AS start,maxIf(tuple(event_time,event_id),(${steps[1]})) AS finish FROM events WHERE ${known} AND ${where} AND ((${steps[0]}) OR (${steps[1]})) GROUP BY bin,who HAVING countIf((${steps[0]}))>0) GROUP BY bin,label ORDER BY at,entered DESC,label LIMIT 20001`,
            bounds(f, t),
          )
        ).data;
      const current = await window(from, to),
        prior = await window(prev, from);
      if (current.length > 20000 || prior.length > 20000)
        throw bad("Too many breakdowns; narrow the range or filter");
      const totals = new Map<string, number>();
      for (const row of [...current, ...prior])
        totals.set(row.label, (totals.get(row.label) ?? 0) + row.entered);
      const bins = bucketGrid(from, to, q.period),
        before = bucketGrid(prev, from, q.period);
      const index = (rows: typeof current) =>
        new Map(rows.map((v) => [JSON.stringify([v.label, v.at]), v]));
      const c = index(current),
        old = index(prior);
      const lines = [...totals]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 12)
        .map(([label]) => {
          let n = 0,
            d = 0;
          const points = bins.map((at, i) => {
            const row = c.get(JSON.stringify([label, at])),
              previous = old.get(JSON.stringify([label, before[i]]));
            n += row?.converted ?? 0;
            d += row?.entered ?? 0;
            return {
              at,
              n: row?.converted ?? 0,
              d: row?.entered ?? 0,
              rate: row ? row.converted / row.entered : null,
              previous: previous ? previous.converted / previous.entered : null,
            };
          });
          const ordered = points.filter((v) => v.rate !== null).sort((a, b) => a.rate! - b.rate!);
          return {
            label: JSON.parse(label) as string | number | boolean | null,
            average: d ? n / d : null,
            best: ordered.at(-1)?.at ?? null,
            worst: ordered[0]?.at ?? null,
            points,
          };
        });
      return { mode: "conversion" as const, lines };
    }
    // Nearest later match for each successive step, from every qualifying start. Keep one
    // furthest-reaching path per counting unit; for ties use its first completion and latest start.
    const base = `SELECT ${key} AS who,row_number() OVER (PARTITION BY who ORDER BY event_time,event_id) AS pos,toUnixTimestamp64Milli(event_time) AS ms,${dim} AS label,ifNull(profile_id,'') AS person,${steps.map((s, i) => `(${s}) AS s${i}`).join(",")} FROM profile_events WHERE ${known} AND ${where} AND (${steps.map((s) => `(${s})`).join(" OR ")})`;
    const joins = steps
      .slice(1)
      .map(
        (_, i) =>
          `ASOF LEFT JOIN (SELECT who,pos,ms,label,person FROM base WHERE s${i + 1}) t${i + 1} ON t${i}.who=t${i + 1}.who AND t${i}.pos<t${i + 1}.pos`,
      )
      .join(" ");
    const valid = (i: number) => `t${i}.pos>0 AND t${i}.ms<=t0.ms+${q.window_hours * 3600000}`;
    const level = `multiIf(${steps
      .slice(1)
      .map((_, i) => i + 1)
      .reverse()
      .map((i) => `${valid(i)},${i + 1}`)
      .join(",")},1)`;
    const time = `multiIf(${steps
      .slice(1)
      .map((_, i) => i + 1)
      .reverse()
      .map((i) => `${valid(i)},t${i}.ms`)
      .join(",")},t0.ms)`;
    const cte = `WITH base AS (${base}), journeys AS (SELECT t0.who AS who,${level} AS lvl,${time} AS end_ms,t0.ms AS start_ms,if(lvl>=${q.at_step},t${q.at_step - 1}.label,'null') AS label,coalesce(${steps.map((_, i) => `nullIf(t${i}.person,'')`).join(",")},'') AS person FROM (SELECT * FROM base WHERE s0) t0 ${joins}), best AS (SELECT who,argMax(tuple(lvl,end_ms-start_ms,label,person),tuple(lvl,-end_ms,start_ms)) AS journey FROM journeys GROUP BY who)`;
    if (b.step) {
      const people = (
        await r.query<{ identity: string; profile: string; level: number }>(
          `${cte} SELECT who AS identity,journey.4 AS profile,journey.1 AS level FROM best WHERE level${b.drop ? "=" : ">="}${b.step} ORDER BY who LIMIT 26 OFFSET ${(b.page - 1) * 25}`,
          bounds(from, to),
        )
      ).data;
      return {
        mode: "funnel_people" as const,
        rows: people.slice(0, 25),
        more: people.length > 25,
      };
    }
    const stats = async (f: Date, t: Date) =>
      (
        await r.query<{
          label: string;
          total: number;
          levels: number[];
          mean: number | null;
          quantiles: number[];
        }>(
          `${cte} SELECT journey.3 AS label,grouping(label) AS total,sumForEach(arrayMap(i->toUInt64(journey.1>=i),range(1,${steps.length + 1}))) AS levels,avgOrNullIf(journey.2,journey.1=${steps.length}) AS mean,quantilesExactInclusiveIf(.25,.5,.75,.90,.95,.99)(journey.2,journey.1=${steps.length}) AS quantiles FROM best GROUP BY GROUPING SETS ((label),()) ORDER BY total DESC,levels[1] DESC,label LIMIT 51`,
          bounds(f, t),
        )
      ).data;
    const current = await stats(from, to),
      prior = await stats(prev, from);
    const totals = current.find((row) => row.total),
      levels = totals?.levels ?? steps.map(() => 0);
    return {
      mode: "funnel" as const,
      levels,
      prior: prior.find((row) => row.total)?.levels ?? steps.map(() => 0),
      mean: totals?.mean ?? null,
      quantiles: totals?.mean != null ? totals.quantiles : [],
      groups: current
        .filter((row) => !row.total)
        .map((row) => ({
          label: JSON.parse(row.label) as string | number | boolean | null,
          levels: row.levels,
        })),
      drop:
        levels.length > 1
          ? levels
              .slice(1)
              .reduce(
                (best, n, i) => (levels[i] - n > levels[best] - levels[best + 1] ? i : best),
                0,
              )
          : 0,
    };
  });
}
