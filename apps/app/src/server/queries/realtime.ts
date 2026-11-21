import type { ApiContext } from "../api/context";
import { fields } from "../api/body";
import { requireSource } from "../db/sources";
import { runSettings } from "../clickhouse/access";
import { readAs } from "./read";
import { cohortScope } from "./cohort-scope";
export async function realtime(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(body, { source_id: "string?", cohort: "string?" });
  const member = await cohortScope(ctx, id, q.cohort),
    table = member ? `profile_events WHERE ${member}` : "events",
    params = { cohort: q.cohort ?? "" };
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  const to = ctx.now(),
    from = new Date(+to - 1800000),
    settings = runSettings({ from, to, source: q.source_id ?? null, bucket: "minute" });
  return readAs(ctx, id, async (r) => {
    const { data } = await r.query<{ kind: string; label: string; count: number }>(
      `SELECT kind,label,count() AS count FROM
      (SELECT arrayJoin([('minute',toString(intDiv(toUnixTimestamp64Milli(event_time)-{start:Int64},60000))),('source',toString(source_id)),('country',country),('path',if(name='page_view',ifNull(properties.path.:String,''),''))]) AS entry,entry.1 AS kind,entry.2 AS label FROM ${table})
      WHERE label!='' GROUP BY kind,label ORDER BY count DESC,label LIMIT 250 BY kind`,
      { settings, params: { ...params, start: +from } },
    );
    const minutes = Array<number>(30).fill(0);
    for (const row of data) if (row.kind === "minute") minutes[Number(row.label)] = row.count;
    const events = (
      await r.query<{
        event_id: string;
        name: string;
        at: number;
        source_id: string;
        path: string;
      }>(
        `SELECT event_id,name,toUnixTimestamp64Milli(event_time) AS at,source_id,ifNull(properties.path.:String,'') AS path FROM ${table} ORDER BY event_time DESC,event_id DESC LIMIT 20`,
        { settings, params },
      )
    ).data;
    // A visit starting before this window can still be active in it.
    const sessions = (
      await r.query<{
        source_id: string;
        actor_id: string;
        session_id: string;
        start: number;
        end: number;
        page_views: number;
        exit_page: string;
      }>(
        `SELECT source_id,actor_id,session_id,toUnixTimestamp64Milli(started_at) AS start,toUnixTimestamp64Milli(ended_at) AS end,page_views,exit_page FROM sessions WHERE ended_at>=fromUnixTimestamp64Milli({start:Int64}) ${member ? `AND (source_id,actor_id,session_id) IN (SELECT source_id,actor_id,session_id FROM profile_events WHERE ${member} AND event_time>=fromUnixTimestamp64Milli({start:Int64}))` : ""} ORDER BY ended_at DESC,source_id,actor_id,session_id LIMIT 20`,
        { settings: { ...settings, SQL_highkey_from: "0" }, params: { ...params, start: +from } },
      )
    ).data;
    const top = (kind: string, limit: number) =>
      data
        .filter((r) => r.kind === kind)
        .slice(0, limit)
        .map(({ label, count }) => ({ label, count }));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      minutes,
      events,
      sessions,
      sources: top("source", 10),
      countries: top("country", 250),
      pages: top("path", 10),
    };
  });
}
