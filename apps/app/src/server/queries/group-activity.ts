import { fields } from "../api/body";
import { bad } from "../api/errors";
import type { ApiContext } from "../api/context";
import { requireSource } from "../db/sources";
import { runSettings } from "../clickhouse/access";
import { readAs } from "./read";
import { parseEventsQuery } from "./events";
import { parseEntityQuery, runEntityQuery } from "./entities";
import { validKey } from "./properties";
import { cohortScope } from "./cohort-scope";

export async function groupActivity(ctx: ApiContext, project: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      type: "string?",
      id: "string?",
      search: "string",
      cohort: "string?",
      page: "integer",
      page_size: "integer",
    },
    { search: "", page: 1, page_size: 25 },
  );
  const { from, to } = parseEventsQuery({ from: q.from, to: q.to });
  const entity = parseEntityQuery({
    type: q.type,
    id: q.id,
    search: q.search,
    page: q.page,
    page_size: q.page_size,
  });
  if (!!q.id !== !!q.type || (q.type && !validKey(q.type)))
    throw bad("Choose both group type and ID");
  if (q.source_id) await requireSource(ctx.db, project, q.source_id);
  const scope = { from, to, source: q.source_id ?? null, bucket: "day" as const };
  const member = await cohortScope(ctx, project, q.cohort);
  const opts = {
    settings: runSettings(scope),
    params: {
      src: q.source_id ?? "",
      cohort: q.cohort ?? "",
      start: +from,
      end: +to,
      type: q.type ?? "",
      id: q.id ?? "",
      search: q.search,
      size: q.page_size,
      offset: (q.page - 1) * q.page_size,
    },
  };
  return readAs(ctx, project, async (r) => {
    if (!q.id) {
      const rows = (
        await r.query<{ type: string; id: string; name: string; members: number; events: number }>(
          `WITH observed AS (
   SELECT pair.1 AS type,pair.2 AS id,count() AS events,uniqExact(profile_id) AS members FROM profile_events ARRAY JOIN arrayZip(mapKeys(groups),mapValues(groups)) AS pair ${member ? `WHERE ${member}` : ""} GROUP BY type,id),
   declared AS (SELECT group_type AS type,group_id AS id,argMaxIf(group_name,tuple(event_time,event_id),notEmpty(group_name)) AS name FROM group_records WHERE event_time<fromUnixTimestamp64Milli({end:Int64}) AND ({src:String}='' OR toString(source_id)={src:String}) GROUP BY type,id)
   SELECT type,id,max(display) AS name,sum(n) AS events,sum(m) AS members FROM (SELECT type,id,'' AS display,events AS n,members AS m FROM observed UNION ALL SELECT type,id,name,0,0 FROM declared) GROUP BY type,id HAVING ${member ? "events>0 AND " : ""}positionCaseInsensitiveUTF8(concat(type,' ',id,' ',name),{search:String})>0 ORDER BY events DESC,type,id LIMIT {size:UInt32}+1 OFFSET {offset:UInt32}`,
          opts,
        )
      ).data;
      return {
        mode: "list" as const,
        rows: rows.slice(0, q.page_size),
        more: rows.length > q.page_size,
      };
    }
    const where = "groups[{type:String}]={id:String}" + (member ? ` AND ${member}` : "");
    const metrics = (
      await r.query<{ members: number; events: number; visits: number; revenue: string }>(
        `SELECT uniqExact(profile_id) AS members,count() AS events,uniqExactIf((source_id,actor_id,session_id),identity_kind='visitor' AND session_id IS NOT NULL) AS visits,toString(sumIf(cents,abs(cents)<=9007199254740991)) AS revenue FROM (SELECT *,coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents FROM profile_events WHERE ${where})`,
        opts,
      )
    ).data[0];
    const newMembers = (
      await r.query<{ day: string; members: number }>(
        `SELECT toDate(first) AS day,count() AS members FROM (SELECT profile_id,min(event_time) AS first FROM profile_events WHERE profile_id IS NOT NULL AND ${where} GROUP BY profile_id) WHERE first>=fromUnixTimestamp64Milli({start:Int64}) GROUP BY day ORDER BY day`,
        { ...opts, settings: runSettings({ ...scope, from: new Date(0) }) },
      )
    ).data;
    const members = (
      await r.query<{ id: string; events: number }>(
        `SELECT profile_id AS id,count() AS events FROM profile_events WHERE profile_id IS NOT NULL AND ${where} GROUP BY profile_id ORDER BY events DESC,id LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
        opts,
      )
    ).data;
    const events = (
      await r.query<{ id: string; name: string; at: number }>(
        `SELECT event_id AS id,name,toUnixTimestamp64Milli(event_time) AS at FROM ${member ? "profile_events" : "events"} WHERE ${where} ORDER BY event_time DESC,event_id LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
        opts,
      )
    ).data;
    const record = (
      await runEntityQuery(r, "groups", { ...entity, page: 1, page_size: 1, search: "" })
    ).rows[0];
    return {
      mode: "detail" as const,
      name: record?.name || q.id,
      traits: record?.traits ?? {},
      metrics,
      newMembers,
      members,
      events,
      more: q.page * q.page_size < Math.max(metrics.members, metrics.events),
    };
  });
}
