import { fields } from "../api/body";
import { bad, missing } from "../api/errors";
import type { ApiContext } from "../api/context";
import { runSettings } from "../clickhouse/access";
import { requireSource } from "../db/sources";
import { parseEventsQuery } from "./events";
import { runEntityQuery, parseEntityQuery } from "./entities";
import { readAs } from "./read";
import { all } from "../db/db";

// Mutation-only profiles also have a place in the directory. Names and emails are text traits.
const names = `SELECT profile_id AS id,
  argMaxIf(traits.name.:String,tuple(event_time,event_id),isNotNull(traits.name.:String)) AS name,
  argMaxIf(traits.email.:String,tuple(event_time,event_id),isNotNull(traits.email.:String)) AS email,
  max(event_time) AS last_identify FROM profile_records
  WHERE profile_id IS NOT NULL AND ({src:String}='' OR toString(source_id)={src:String}) AND event_time < fromUnixTimestamp64Milli({end:Int64})
  GROUP BY profile_id`;
const validId = (value: string) =>
  value.length > 0 && new TextEncoder().encode(value).length <= 128;
export async function peopleList(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      kind: "string",
      search: "string",
      group_type: "string?",
      group_id: "string?",
      page: "integer",
      page_size: "integer",
    },
    { kind: "identified", search: "", page: 1, page_size: 25 },
  );
  const { from, to } = parseEventsQuery({ from: q.from, to: q.to });
  if (
    !["identified", "anonymous", "power"].includes(q.kind) ||
    q.search.length > 256 ||
    q.page < 1 ||
    q.page > 10000 ||
    q.page_size < 1 ||
    q.page_size > 100 ||
    !!q.group_type !== !!q.group_id ||
    (q.group_id != null && !validId(q.group_id)) ||
    (q.group_type != null && !/^[A-Za-z0-9_./-]{1,64}$/.test(q.group_type))
  )
    throw bad("Invalid profile filter or page");
  if (q.source_id != null) await requireSource(ctx.db, id, q.source_id);
  const anonymous = q.kind === "anonymous",
    key = anonymous ? "actor_id" : "profile_id";
  const start = q.kind === "power" ? new Date(+to - 90 * 86400000) : from;
  const members = q.group_type ? " AND groups[{type:String}]={group:String}" : "";
  const stats = `SELECT assumeNotNull(${key}) AS id,count() AS n,max(event_time) AS seen FROM profile_events
    WHERE ${anonymous ? "profile_id IS NULL AND identity_kind='visitor' AND actor_id IS NOT NULL" : "profile_id IS NOT NULL"}${members} GROUP BY ${key}`;
  const identified = `SELECT if(a.id='',t.id,a.id) AS id,t.name,t.email,ifNull(a.n,0) AS events,greatest(a.seen,t.last_identify) AS seen
    FROM (${stats}) a ${q.kind === "power" || members ? "LEFT" : "FULL OUTER"} JOIN (${names}) t USING(id)`;
  const result = await readAs(ctx, id, (r) =>
    r.query<{
      id: string;
      name: string | null;
      email: string | null;
      events: number;
      last_seen: number;
    }>(
      `SELECT id,name,email,events,toUnixTimestamp64Milli(seen) AS last_seen FROM (
      ${anonymous ? `SELECT id,NULL AS name,NULL AS email,n AS events,seen FROM (${stats})` : identified}
    ) WHERE seen>=fromUnixTimestamp64Milli({start:Int64}) AND positionCaseInsensitiveUTF8(concat(id,' ',ifNull(name,''),' ',ifNull(email,'')),{search:String})>0
    ORDER BY ${q.kind === "power" ? "events DESC," : ""} seen DESC,id LIMIT {size:UInt32}+1 OFFSET {offset:UInt32}`,
      {
        settings: runSettings({ from: start, to, source: q.source_id ?? null, bucket: "day" }),
        params: {
          start: +start,
          end: +to,
          src: q.source_id ?? "",
          search: q.search,
          type: q.group_type ?? "",
          group: q.group_id ?? "",
          size: q.page_size,
          offset: (q.page - 1) * q.page_size,
        },
      },
    ),
  );
  return {
    rows: result.data.slice(0, q.page_size),
    has_more: result.rows > q.page_size,
    page: q.page,
    page_size: q.page_size,
  };
}

export async function personDetail(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      id: "string",
      anonymous: "boolean",
      page: "integer",
      page_size: "integer",
    },
    { anonymous: false, page: 1, page_size: 25 },
  );
  const { from, to } = parseEventsQuery({ from: q.from, to: q.to });
  if (!validId(q.id) || q.page < 1 || q.page > 10000 || q.page_size < 1 || q.page_size > 100)
    throw bad("Invalid profile id or page");
  if (q.source_id != null) await requireSource(ctx.db, id, q.source_id);
  const settings = runSettings({ from, to, source: q.source_id ?? null, bucket: "day" });
  const conversions = (
    await all<{ name: string }>(
      ctx.db,
      "SELECT name FROM event_catalog WHERE product_id=? AND conversion=1",
      [id],
    )
  ).map((r) => r.name);
  const options = {
    settings,
    params: { id: q.id, size: q.page_size, offset: (q.page - 1) * q.page_size, conversions },
  };
  const where = q.anonymous
    ? "profile_id IS NULL AND identity_kind='visitor' AND actor_id={id:String}"
    : "profile_id={id:String}";
  return readAs(ctx, id, async (r) => {
    const s = (
      await r.query<{
        events: number;
        page_views: number;
        days_active: number;
        conversions: number;
        revenue_cents: string;
        groups: [string, string][];
      }>(
        `SELECT count() AS events,countIf(name='page_view') AS page_views,uniqExact(toDate(event_time)) AS days_active,countIf(has({conversions:Array(String)},name)) AS conversions,
       toString(sumIf(cents,abs(cents)<=9007199254740991)) AS revenue_cents,
       groupUniqArrayArray(100)(arrayZip(mapKeys(groups),mapValues(groups))) AS groups
       FROM (SELECT *,coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents FROM profile_events WHERE ${where})`,
        options,
      )
    ).data[0];
    const entity = q.anonymous
      ? undefined
      : (await runEntityQuery(r, "profiles", parseEntityQuery({ id: q.id }))).rows[0];
    const calendar = (
      await r.query<{ day: string; events: number }>(
        `SELECT toDate(event_time) AS day,count() AS events FROM profile_events WHERE ${where} GROUP BY day ORDER BY day`,
        {
          ...options,
          settings: runSettings({
            from: new Date(+to - 365 * 86400000),
            to,
            source: q.source_id ?? null,
            bucket: "day",
          }),
        },
      )
    ).data;
    if (!s?.events && !entity && !calendar.length) throw missing();
    // The actor and source are part of a session key, so reused session strings never link two visitors.
    const visits = `FROM sessions WHERE (source_id,actor_id,session_id) IN (SELECT source_id,actor_id,session_id FROM profile_events WHERE ${where} AND session_id IS NOT NULL)`;
    const stats = (
      await r.query<{
        sessions: number;
        bounce_rate: number | null;
        p90_ms: number | null;
        average_gap_ms: number | null;
      }>(
        `SELECT count() AS sessions,avgOrNull(toUInt8(bounced))*100 AS bounce_rate,quantileExactInclusiveOrNull(.90)(duration_ms) AS p90_ms,
       if(count()>1,(max(toUnixTimestamp64Milli(started_at))-min(toUnixTimestamp64Milli(started_at)))/nullIf(count()-1,0),NULL) AS average_gap_ms ${visits}`,
        options,
      )
    ).data[0];
    const sessions = (
      await r.query<{
        source_id: string;
        session_id: string;
        actor_id: string;
        start: number;
        events: number;
        duration_ms: number;
      }>(
        `SELECT source_id,session_id,actor_id,toUnixTimestamp64Milli(started_at) AS start,events,duration_ms ${visits} ORDER BY started_at DESC,source_id,actor_id,session_id LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
        options,
      )
    ).data;
    const top = (expr: string, extra: string) =>
      r
        .query<{ label: string; n: number }>(
          `SELECT ${expr} AS label,count() AS n FROM profile_events WHERE ${where} ${extra} GROUP BY label ORDER BY n DESC,label LIMIT 10`,
          options,
        )
        .then((v) => v.data);
    const pages = await top(
      "properties.path.:String",
      "AND name='page_view' AND notEmpty(properties.path.:String)",
    );
    const names = await top("name", "");
    const events = (
      await r.query<{
        event_id: string;
        name: string;
        time: number;
        properties: Record<string, unknown>;
      }>(
        `SELECT event_id,name,toUnixTimestamp64Milli(event_time) AS time,properties FROM profile_events WHERE ${where} ORDER BY event_time DESC,event_id DESC LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
        options,
      )
    ).data;
    return {
      id: q.id,
      traits: entity?.traits ?? {},
      ...s,
      ...stats,
      events_per_session: stats?.sessions ? s.events / stats.sessions : null,
      calendar,
      pages,
      top_events: names,
      latest: events,
      visits: sessions,
      page: q.page,
      page_size: q.page_size,
    };
  });
}
