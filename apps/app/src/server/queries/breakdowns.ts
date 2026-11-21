import { fields } from "../api/body";
import type { ApiContext } from "../api/context";
import { bad } from "../api/errors";
import { requireSource } from "../db/sources";
import { runSettings } from "../clickhouse/access";
import { parseEventsQuery, predicate } from "./events";
import { customRules } from "./custom";
import { Params, path } from "./properties";
import { readAs } from "./read";

export async function breakdownReport(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      event: "string?",
      names: "string[]?",
      source: "string?",
      filters: "unknown",
      dimension: "string",
      search: "string",
      sort: "string",
      page: "integer",
      page_size: "integer",
    },
    { dimension: "name", search: "", sort: "volume", page: 1, page_size: 25 },
  );
  const spec = parseEventsQuery({
    from: q.from,
    to: q.to,
    event: q.event,
    names: q.names,
    source: q.source,
    filters: q.filters,
  });
  const sort = new Map([
    ["volume", "volume DESC"],
    ["label", "label ASC"],
    ["growth", "change DESC NULLS LAST"],
    ["trend", "slope DESC"],
    ["revenue", "net DESC"],
  ]).get(q.sort);
  if (
    !sort ||
    q.page < 1 ||
    q.page > 10000 ||
    q.page_size < 1 ||
    q.page_size > (q.dimension === "property:context.country" ? 250 : 100) ||
    q.search.length > 512
  )
    throw bad("Invalid breakdown search, page or sort");
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  const dimension = ["name", "source", "source_id", "identity_kind"].includes(q.dimension)
    ? `toJSONString(${q.dimension})`
    : q.dimension.startsWith("property:")
      ? `toJSONString(${path("properties", q.dimension.slice(9))})`
      : null;
  if (!dimension) throw bad("Unknown breakdown dimension");
  const params = new Params(),
    where = predicate(
      spec,
      params,
      spec.event?.startsWith("@") || spec.names?.some((n) => n.startsWith("@"))
        ? await customRules(ctx.db, id)
        : undefined,
    );
  const isPage = q.dimension === "property:path";
  const from = +spec.from,
    span = +spec.to - from;
  const settings = runSettings({
    from: new Date(from - span),
    to: spec.to,
    source: q.source_id ?? null,
    bucket: "day",
  });
  const opts = {
    settings,
    params: {
      ...params.values,
      start: from,
      span,
      search: q.search,
      size: q.page_size,
      offset: (q.page - 1) * q.page_size,
    },
  };
  const key = "source_id,actor_id,session_id";
  const pageMetrics = isPage
    ? `, eligible AS (SELECT DISTINCT ${key} FROM events WHERE event_time>=fromUnixTimestamp64Milli({start:Int64}) AND name='page_view' AND identity_kind='visitor' AND session_id IS NOT NULL AND ${where}),
  visits AS (SELECT ${key},event_id,${dimension} AS label,event_time,
    row_number() OVER w AS pos,count() OVER (PARTITION BY ${key}) AS pages,leadInFrame(toNullable(event_time),1,NULL) OVER (PARTITION BY ${key} ORDER BY event_time,event_id ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS following
    FROM all_events WHERE name='page_view' AND NOT backfill AND identity_kind='visitor' AND (${key}) IN eligible WINDOW w AS (PARTITION BY ${key} ORDER BY event_time,event_id)),
  page_stats AS (SELECT label,countIf(pos=1) AS entries,countIf(pos=pages) AS exits,100*countIf(pages=1)/nullIf(countIf(pos=1),0) AS bounce_rate,avgOrNull(dateDiff('millisecond',event_time,following)) AS time_ms FROM visits WHERE event_id IN (SELECT event_id FROM events WHERE event_time>=fromUnixTimestamp64Milli({start:Int64}) AND ${where}) GROUP BY label)`
    : "";
  const result = await readAs(ctx, id, (r) =>
    r.query<{
      label: string;
      volume: number;
      prior: number;
      share: number;
      change: number | null;
      trend: number[];
      cents: string;
      entries: number;
      exits: number;
      bounce_rate: number | null;
      time_ms: number | null;
      matches: number;
    }>(
      `WITH grouped AS (
   SELECT ${dimension} AS label,countIf(current AND eligible_event) AS volume,countIf(NOT current AND eligible_event) AS prior,
   sumIf(cents,current AND abs(cents)<=9007199254740991) AS net,
   sumMapIf(map(bin,toUInt64(1)),current AND eligible_event) AS bins
   FROM (SELECT *,toUnixTimestamp64Milli(event_time)>={start:Int64} AS current,${isPage ? "name='page_view'" : "1"} AS eligible_event,
   toUInt8(greatest(0,least(13,intDiv((toUnixTimestamp64Milli(event_time)-{start:Int64})*14,{span:Int64})))) AS bin,
   coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents FROM events WHERE ${where})
   GROUP BY label HAVING volume OR prior OR net!=0),
   ranked AS (SELECT *,volume/nullIf(sum(volume) OVER (),0) AS fraction,(toFloat64(volume)-prior)*100/nullIf(prior,0) AS change,
   arrayMap(i->bins[toUInt8(i)],range(14)) AS trend,arraySum(arrayMap((n,i)->toFloat64(n)*(toInt32(i)*2-13),trend,range(14))) AS slope FROM grouped)
   ${pageMetrics} SELECT label,volume,prior,ifNull(fraction,0) AS share,change,trend,toString(net) AS cents,
   ${isPage ? "ifNull(entries,0) AS entries,ifNull(exits,0) AS exits,bounce_rate,time_ms" : "0 AS entries,0 AS exits,NULL AS bounce_rate,NULL AS time_ms"},count() OVER () AS matches FROM ranked ${isPage ? "LEFT JOIN page_stats USING (label)" : ""}
   WHERE positionCaseInsensitiveUTF8(label,{search:String})>0 ORDER BY ${sort},label LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
      opts,
    ),
  );
  return {
    rows: result.data.map(({ matches: _, label, ...row }) => ({
      ...row,
      label: JSON.parse(label) as string | number | boolean | null,
    })),
    total: result.data[0]?.matches ?? 0,
    page: q.page,
    page_size: q.page_size,
  };
}
