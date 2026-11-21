import { fields } from "../api/body";
import type { ApiContext } from "../api/context";
import { bad } from "../api/errors";
import { runSettings } from "../clickhouse/access";
import { requireSource } from "../db/sources";
import { customRules } from "./custom";
import { parseEventsQuery, predicate } from "./events";
import { Params } from "./properties";
import { readAs } from "./read";

export async function patterns(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      mode: "string",
      from: "string",
      to: "string",
      source_id: "string?",
      event: "string?",
      source: "string?",
      filters: "unknown",
      identity_kind: "string?",
      steps: "integer",
      start_path: "string",
      end_path: "string",
    },
    { steps: 5, start_path: "", end_path: "" },
  );
  if (
    !["weekly", "distribution", "flow"].includes(q.mode) ||
    q.steps < 2 ||
    q.steps > 10 ||
    q.start_path.length > 2048 ||
    q.end_path.length > 2048
  )
    throw bad("Choose weekly, distribution or flow and 2–10 steps");
  const query = parseEventsQuery({
    from: q.from,
    to: q.to,
    event: q.event,
    source: q.source,
    filters: q.filters,
    identity_kind: q.identity_kind,
  });
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  const params = new Params();
  const where = predicate(
    query,
    params,
    q.event?.startsWith("@") ? await customRules(ctx.db, id) : undefined,
  );
  const options = {
    settings: runSettings({ ...query, source: q.source_id ?? null }),
    params: params.values,
  };
  const key = "source_id,actor_id,session_id";
  // A filter selects qualifying visits, not individual pages within the returned path.
  const filterVisits =
    q.event || q.source || query.filters.length || q.identity_kind
      ? ` AND (${key}) IN (SELECT ${key} FROM events WHERE identity_kind='visitor' AND session_id IS NOT NULL AND ${where})`
      : "";
  return readAs(ctx, id, async (reader) => {
    if (q.mode === "distribution") {
      const result = await reader.query<{ bucket: number; actors: number }>(
        `SELECT multiIf(n<=3,n,n<=5,4,n<=10,5,6) AS bucket,count() AS actors FROM (
        SELECT count() AS n FROM events WHERE actor_id IS NOT NULL AND ${where} GROUP BY identity_kind,actor_id
      ) GROUP BY bucket ORDER BY bucket`,
        options,
      );
      return {
        mode: "distribution" as const,
        buckets: ["1", "2", "3", "4–5", "6–10", "11+"].map((label, i) => ({
          label,
          actors: result.data.find((r) => r.bucket === i + 1)?.actors ?? 0,
        })),
      };
    }
    if (q.mode === "weekly") {
      const visitors = await reader.query<{ weekday: number; hour: number; visitors: number }>(
        `SELECT toDayOfWeek(event_time) AS weekday,toHour(event_time) AS hour,uniqExact(actor_id) AS visitors
        FROM events WHERE identity_kind='visitor' AND actor_id IS NOT NULL AND ${where} GROUP BY weekday,hour`,
        options,
      );
      const visits = await reader.query<{
        weekday: number;
        hour: number;
        sessions: number;
        bounce_rate: number;
        duration_ms: number;
      }>(
        `SELECT toDayOfWeek(started_at) AS weekday,toHour(started_at) AS hour,count() AS sessions,avg(bounced)*100 AS bounce_rate,avg(duration_ms) AS duration_ms
        FROM sessions WHERE 1 ${filterVisits} GROUP BY weekday,hour`,
        options,
      );
      return {
        mode: "weekly" as const,
        cells: Array.from({ length: 168 }, (_, i) => {
          const weekday = Math.floor(i / 24) + 1,
            hour = i % 24;
          const visit = visits.data.find((r) => r.weekday === weekday && r.hour === hour);
          return {
            weekday,
            hour,
            visitors:
              visitors.data.find((r) => r.weekday === weekday && r.hour === hour)?.visitors ?? 0,
            sessions: visit?.sessions ?? 0,
            bounce_rate: visit?.bounce_rate ?? null,
            duration_ms: visit?.duration_ms ?? null,
          };
        }),
      };
    }
    const optionsFlow = {
      ...options,
      params: { ...params.values, steps: q.steps, start: q.start_path, end: q.end_path },
    };
    const result = await reader.query<{ pages: string[]; sessions: number; total: number }>(
      `WITH
      pages AS (SELECT ${key},assumeNotNull(properties.path.:String) AS page,
        row_number() OVER (PARTITION BY ${key} ORDER BY event_time,event_id) AS pos FROM events
        WHERE identity_kind='visitor' AND actor_id IS NOT NULL AND session_id IS NOT NULL AND NOT backfill AND name='page_view' AND notEmpty(properties.path.:String) ${filterVisits}),
      starts AS (SELECT *,minIf(pos,page={start:String}) OVER (PARTITION BY ${key}) AS start_match FROM pages),
      ends AS (SELECT *,minIf(pos,page={end:String} AND ({start:String}='' OR pos>=start_match)) OVER (PARTITION BY ${key}) AS end_match FROM starts),
      paths AS (SELECT arrayMap(t->t.2,arraySort(groupArray(tuple(pos,page)))) AS path FROM ends
        WHERE ({start:String}='' OR start_match>0) AND ({end:String}='' OR end_match>0)
        AND ({end:String}='' OR pos<=end_match) AND ({start:String}='' OR pos>=start_match)
        AND if({start:String}='' AND {end:String}!='',pos+{steps:UInt32}>end_match,pos<if({start:String}='',1,start_match)+{steps:UInt32})
        AND ({start:String}='' OR {end:String}='' OR end_match<start_match+{steps:UInt32})
        GROUP BY ${key} HAVING length(path)>=2)
      SELECT path AS pages,count() AS sessions,sum(count()) OVER () AS total FROM paths GROUP BY path ORDER BY sessions DESC,path LIMIT 20`,
      optionsFlow,
    );
    return {
      mode: "flow" as const,
      paths: result.data.map(({ total: _, ...r }) => r),
      total: result.data[0]?.total ?? 0,
    };
  });
}
