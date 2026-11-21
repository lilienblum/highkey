import { fields } from "../api/body";
import type { ApiContext } from "../api/context";
import { bad, missing } from "../api/errors";
import { runSettings } from "../clickhouse/access";
import { requireSource } from "../db/sources";
import { parseEventsQuery } from "./events";
import { Params } from "./properties";
import { readAs } from "./read";

type Session = {
  source_id: string;
  session_id: string;
  actor_id: string;
  profile_id: string | null;
  start: number;
  end: number;
  duration_ms: number;
  events: number;
  page_views: number;
  bounced: boolean;
  entry_page: string;
  exit_page: string;
  referrer: string;
  campaign: Record<string, string>;
  revenue_cents: string;
};

const columns = `source_id, session_id, actor_id, profile_id, toUnixTimestamp64Milli(started_at) AS start,
  toUnixTimestamp64Milli(ended_at) AS end, duration_ms, events, page_views, toBool(bounced) AS bounced,
  entry_page, exit_page, referrer, campaign, revenue_cents`;

function pageBounds(page: number, size: number) {
  if (page < 1 || page > 10000 || size < 1 || size > 100)
    throw bad("Use page 1–10000 and page_size 1–100");
  return { offset: (page - 1) * size, size };
}

export async function sessionList(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      search: "string",
      bounced: "unknown",
      min_duration_ms: "integer",
      min_page_views: "integer",
      profile_id: "string?",
      page: "integer",
      page_size: "integer",
    },
    { search: "", min_duration_ms: 0, min_page_views: 0, page: 1, page_size: 25 },
  );
  const { from, to } = parseEventsQuery({ from: q.from, to: q.to });
  const bounds = pageBounds(q.page, q.page_size);
  if (
    q.search.length > 512 ||
    !Number.isSafeInteger(q.min_duration_ms) ||
    q.min_duration_ms < 0 ||
    !Number.isSafeInteger(q.min_page_views) ||
    q.min_page_views < 0 ||
    (q.bounced != null && typeof q.bounced !== "boolean") ||
    (q.profile_id != null && new TextEncoder().encode(q.profile_id).length > 128)
  )
    throw bad(
      "Use a bounded search, nonnegative duration and page views, and a boolean bounce filter",
    );
  if (q.source_id != null) await requireSource(ctx.db, id, q.source_id);
  const params = new Params();
  const parts = ["1"];
  if (q.min_duration_ms) parts.push(`duration_ms >= ${params.add("UInt64", q.min_duration_ms)}`);
  if (q.min_page_views) parts.push(`page_views >= ${params.add("UInt64", q.min_page_views)}`);
  if (q.bounced != null) parts.push(`bounced = ${params.add("Bool", q.bounced)}`);
  if (q.profile_id != null) parts.push(`profile_id = ${params.add("String", q.profile_id)}`);
  if (q.search) {
    const term = params.add("String", q.search);
    // Search every visited path, including intermediate pages in sessions crossing the range end.
    parts.push(`(positionCaseInsensitiveUTF8(referrer,${term})>0 OR
      (source_id,actor_id,session_id) IN (SELECT source_id,actor_id,session_id FROM all_events
        WHERE name='page_view' AND session_id IS NOT NULL AND positionCaseInsensitiveUTF8(properties.path.:String,${term})>0))`);
  }
  const options = {
    settings: runSettings({ from, to, source: q.source_id ?? null, bucket: "day" }),
    params: { ...params.values, ...bounds },
  };
  const result = await readAs(ctx, id, (r) =>
    r.query<Session>(
      `SELECT ${columns} FROM sessions WHERE ${parts.join(" AND ")}
    ORDER BY started_at DESC, source_id, actor_id, session_id LIMIT {size:UInt32}+1 OFFSET {offset:UInt32}`,
      options,
    ),
  );
  return {
    rows: result.data.slice(0, q.page_size),
    has_more: result.rows > q.page_size,
    page: q.page,
    page_size: q.page_size,
  };
}

export async function sessionDetail(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string",
      actor_id: "string",
      session_id: "string",
      page: "integer",
      page_size: "integer",
    },
    { page: 1, page_size: 50 },
  );
  const { from, to } = parseEventsQuery({ from: q.from, to: q.to });
  if (
    ![q.actor_id, q.session_id].every((v) => v.length && new TextEncoder().encode(v).length <= 128)
  )
    throw bad("Invalid session identity");
  const bounds = pageBounds(q.page, q.page_size);
  await requireSource(ctx.db, id, q.source_id);
  const settings = runSettings({ from, to, source: q.source_id, bucket: "day" });
  const params = { ...bounds, source: q.source_id, actor: q.actor_id, session: q.session_id };
  const key = "source_id={source:UUID} AND actor_id={actor:String} AND session_id={session:String}";
  return readAs(ctx, id, async (r) => {
    const session = (
      await r.query<Session>(`SELECT ${columns} FROM sessions WHERE ${key} LIMIT 1`, {
        params,
        settings,
      })
    ).data[0];
    if (!session) throw missing();
    const where = `${key} AND identity_kind='visitor'`;
    const events = await r.query<{
      event_id: string;
      name: string;
      timestamp: number;
      properties: Record<string, unknown>;
      profile_id: string | null;
      backfill: boolean;
    }>(
      `SELECT event_id,name,toUnixTimestamp64Milli(event_time) AS timestamp,properties,profile_id,backfill
       FROM all_events WHERE ${where} ORDER BY event_time,event_id LIMIT {size:UInt32}+1 OFFSET {offset:UInt32}`,
      { params },
    );
    const ranked = (label: string, condition: string) =>
      r
        .query<{ label: string; n: number }>(
          `SELECT ${label} AS label,count() AS n FROM all_events WHERE ${where} AND ${condition}
      GROUP BY label ORDER BY n DESC,label LIMIT 10`,
          { params },
        )
        .then((result) => result.data);
    const pages = await ranked(
      "properties.path.:String",
      "name='page_view' AND notEmpty(properties.path.:String)",
    );
    const mix = await ranked("name", "1");
    // Correlate only explicit ids and only within the live boundaries; never guess from time alone.
    const ids = (key: string) =>
      `(SELECT properties.${key}.:String FROM all_events WHERE ${where} AND notEmpty(properties.${key}.:String))`;
    const logs = await r.query<{
      log_id: string;
      time: number;
      service: string;
      level: string;
      message: string;
      request_id: string | null;
      trace_id: string | null;
    }>(
      `SELECT log_id,toUnixTimestamp64Milli(timestamp) AS time,service,level,message,trace_id,request_id FROM all_logs AS l
      WHERE l.timestamp BETWEEN fromUnixTimestamp64Milli({start:Int64}) AND fromUnixTimestamp64Milli({end:Int64})
        AND (l.trace_id IN ${ids("trace_id")} OR l.request_id IN ${ids("request_id")})
      ORDER BY l.timestamp,l.log_id LIMIT 51`,
      { params: { ...params, start: session.start, end: session.end } },
    );
    return {
      session,
      events: events.data.slice(0, q.page_size),
      has_more: events.rows > q.page_size,
      page: q.page,
      page_size: q.page_size,
      pages,
      mix,
      logs: logs.data.slice(0, 50),
      more_logs: logs.rows > 50,
    };
  });
}

/** Look up a known visit even if the inspected event's date range starts mid-visit. */
export async function sessionSummary(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(body, { source_id: "string", actor_id: "string", session_id: "string" });
  if (
    ![q.actor_id, q.session_id].every((v) => v.length && new TextEncoder().encode(v).length <= 128)
  )
    throw bad("Invalid session identity");
  await requireSource(ctx.db, id, q.source_id);
  const result = await readAs(ctx, id, (r) =>
    r.query<Pick<Session, "events" | "page_views" | "duration_ms" | "start">>(
      `SELECT events,page_views,duration_ms,toUnixTimestamp64Milli(started_at) AS start FROM sessions
     WHERE source_id={source_id:UUID} AND actor_id={actor_id:String} AND session_id={session_id:String} LIMIT 1`,
      {
        params: q,
        settings: runSettings({
          from: new Date(0),
          to: new Date(ctx.now().getTime() + 60001),
          source: q.source_id,
          bucket: "day",
        }),
      },
    ),
  );
  return result.data[0] ?? null;
}
