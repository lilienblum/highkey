import type { ApiContext } from "./api/context";
import { all, one } from "./db/db";
import { runSettings } from "./clickhouse/access";
import { readAs } from "./queries/read";
import { parseEventsQuery } from "./queries/events";
import {
  type Notice,
  type NotificationRule,
  destinationBody,
  enqueueNotice,
} from "./notifications";
import { route, READ } from "./api/router";
import { json } from "./api/errors";
import { readJson, fields } from "./api/body";
import { listSources } from "./db/sources";
const day = 86400000;
type Trend = {
  dimension: string;
  label: string;
  days: number;
  current: number;
  prior: number;
  severity: "high" | "medium";
  spike: boolean;
};
type Report = { trends: Trend[]; weekly: number; prior_week: number };
type LastSeen = { source_id: string; kind: string; service: string; seen_ms: number };
const labels: Record<string, string> = {
  referrer: "Referrer",
  entry: "Entry page",
  page: "Page",
  country: "Country",
  device: "Device",
  version: "CLI version",
  error: "Command errors",
  platform: "Platform",
};
export const trendTitle = (v: Trend) =>
  `${v.spike ? "Referrer spike" : (labels[v.dimension] ?? v.dimension)}: ${v.label}`;
export const trendText = (v: Trend) =>
  v.spike
    ? `${v.current} sessions vs ${Number(v.prior.toFixed(1))} per day over the previous seven days`
    : `${v.current} vs ${v.prior} in the prior ${v.days === 1 ? "day" : `${v.days} days`}`;
export async function insights(ctx: ApiContext, id: string, body: unknown) {
  const { from, to } = parseEventsQuery(fields(body, { from: "string", to: "string" }));
  const reports = await all<{ day_ms: number; report: string }>(
    ctx.db,
    "SELECT day_ms,report FROM daily_insights WHERE product_id=? AND day_ms>=? AND day_ms<? ORDER BY day_ms DESC LIMIT 366",
    [id, +from - day + 1, +to - day + 1],
  );
  return reports.flatMap((r) =>
    (JSON.parse(r.report) as Report).trends.map((t) => ({
      ...t,
      at: r.day_ms + day - 1,
      title: trendTitle(t),
      description: trendText(t),
    })),
  );
}
async function analyze(ctx: ApiContext, id: string, end: number): Promise<Report> {
  const options = {
    settings: runSettings({
      from: new Date(end - 60 * day),
      to: new Date(end),
      source: null,
      bucket: "day",
    }),
    params: { end },
  };
  return readAs(ctx, id, async (r) => {
    const movement = (
      await r.query<Trend>(
        `WITH dimensions AS (
 SELECT toDate(event_time) AS dt,arrayJoin(arrayFilter(x->notEmpty(x.2),[
 ('page',if(name='page_view',ifNull(properties.path.:String,''),'')),('country',country),('device',device),
 ('version',if(source='cli',ifNull(properties.version.:String,''),'')),('platform',if(source='cli',ifNull(properties.os.:String,''),'')),
 ('error',if(source='cli' AND (properties.success.:Bool=false OR properties.exit_code.:Int64!=0),ifNull(properties.command.:String,name),''))])) AS d,count() AS n
 FROM events GROUP BY dt,d
 UNION ALL SELECT toDate(started_at) AS dt,arrayJoin(arrayFilter(x->notEmpty(x.2),[('entry',entry_page),('referrer',referrer)])) AS d,count() AS n FROM sessions GROUP BY dt,d),
 counts AS (SELECT d.1 AS dimension,leftUTF8(d.2,240) AS label,arrayJoin([1,7,30]) AS days,
 sumIf(n,dt>=toDate(fromUnixTimestamp64Milli({end:Int64}))-days) AS current,
 sumIf(n,dt<toDate(fromUnixTimestamp64Milli({end:Int64}))-days AND dt>=toDate(fromUnixTimestamp64Milli({end:Int64}))-2*days) AS prior
 FROM dimensions GROUP BY dimension,label,days HAVING greatest(current,prior)>=5 AND abs(toInt64(current)-toInt64(prior))>=greatest(3,0.25*prior))
 SELECT *,if(abs(toInt64(current)-toInt64(prior))>=greatest(10,prior),'high','medium') AS severity,false AS spike FROM counts ORDER BY abs(toInt64(current)-toInt64(prior)) DESC,dimension,label LIMIT 6 BY days`,
        options,
      )
    ).data;
    const spikes = (
      await r.query<Trend>(
        `SELECT 'referrer' AS dimension,referrer AS label,1 AS days,
 countIf(started_at>=fromUnixTimestamp64Milli({end:Int64})-INTERVAL 1 DAY) AS current,
 countIf(started_at<fromUnixTimestamp64Milli({end:Int64})-INTERVAL 1 DAY)/7 AS prior,'high' AS severity,true AS spike
 FROM sessions WHERE started_at>=fromUnixTimestamp64Milli({end:Int64})-INTERVAL 8 DAY GROUP BY referrer
 QUALIFY notEmpty(label) AND current>=10 AND current>=3*prior AND current>=0.15*sum(current) OVER () ORDER BY current DESC,label LIMIT 10`,
        options,
      )
    ).data;
    const counts = (
      await r.query<{ weekly: number; prior_week: number }>(
        `SELECT countIf(event_time>=fromUnixTimestamp64Milli({end:Int64})-INTERVAL 7 DAY) AS weekly,countIf(event_time<fromUnixTimestamp64Milli({end:Int64})-INTERVAL 7 DAY) AS prior_week FROM events WHERE event_time>=fromUnixTimestamp64Milli({end:Int64})-INTERVAL 14 DAY`,
        options,
      )
    ).data[0];
    return {
      ...counts,
      trends: [
        ...spikes,
        ...movement.filter(
          (t) =>
            !spikes.some(
              (s) => s.days === t.days && s.dimension === t.dimension && s.label === t.label,
            ),
        ),
      ],
    };
  });
}
async function health(ctx: ApiContext, id: string, now: number) {
  const sources = await listSources(ctx.db, id);
  const recent = (
    await readAs(ctx, id, (r) =>
      r.query<LastSeen>(`SELECT source_id,'event' AS kind,'' AS service,toUnixTimestamp64Milli(max(received_at)) AS seen_ms FROM all_events GROUP BY source_id
 UNION ALL SELECT source_id,'log' AS kind,service,toUnixTimestamp64Milli(max(received_at)) AS seen_ms FROM all_logs GROUP BY source_id,service`),
    )
  ).data;
  if (recent.length)
    await ctx.db.batch(
      recent.map((v) => ({
        sql: "INSERT INTO signal_last_seen VALUES(?,?,?,?,?) ON CONFLICT(product_id,source_id,kind,service) DO UPDATE SET seen_ms=max(seen_ms,excluded.seen_ms)",
        args: [id, v.source_id, v.kind, v.service, v.seen_ms],
      })),
      "write",
    );
  const seen = await all<LastSeen>(ctx.db, "SELECT * FROM signal_last_seen WHERE product_id=?", [
    id,
  ]);
  const alerts: { origin: string; name: string; source_id: string }[] = [];
  for (const s of sources) {
    if (!seen.some((v) => v.source_id === s.id) && now - Date.parse(s.created_at) >= 2 * day)
      alerts.push({ origin: `new:${s.id}`, name: `No data yet from ${s.name}`, source_id: s.id });
    for (const v of seen.filter((v) => v.source_id === s.id && now - v.seen_ms >= day))
      alerts.push({
        origin: JSON.stringify([s.id, v.kind, v.service, v.seen_ms]),
        name: `Data stopped: ${s.name}${v.kind === "log" ? ` / ${v.service} logs` : " events"}`,
        source_id: s.id,
      });
  }
  return alerts;
}
export async function nightlyProject(ctx: ApiContext, id: string) {
  const now = +ctx.now(),
    end = Math.floor(now / day) * day,
    at = end - day;
  if (await one(ctx.db, "SELECT 1 FROM daily_insights WHERE product_id=? AND day_ms=?", [id, at]))
    return;
  const report = await analyze(ctx, id, end);
  const rules = await all<NotificationRule>(
    ctx.db,
    "SELECT * FROM notification_rules WHERE product_id=? AND enabled=1 AND kind IN ('health','digest')",
    [id],
  );
  const alerts = rules.some((r) => r.kind === "health") ? await health(ctx, id, now) : [];
  const base: Notice = {
    origin: "",
    ms: now,
    event_id: null,
    event_ms: null,
    source_id: null,
    profile_id: null,
    name: "",
    properties: {},
    email: null,
    country: "",
  };
  for (const rule of rules) {
    const body = await destinationBody(ctx, rule);
    if (rule.kind === "health") {
      for (const a of alerts) await enqueueNotice(ctx.db, rule, { ...base, ...a }, now, body);
      continue;
    }
    if (new Date(end).getUTCDay() === 1) {
      const top = report.trends
        .filter((t) => t.days === 7)
        .slice(0, 3)
        .map((t) => `${trendTitle(t)} (${trendText(t)})`);
      await enqueueNotice(
        ctx.db,
        rule,
        {
          ...base,
          origin: `week:${end}`,
          properties: { events: report.weekly, previous: report.prior_week },
          name: [
            `Weekly digest: ${report.weekly} events, compared with ${report.prior_week} the previous week`,
            ...top,
          ].join(". "),
        },
        now,
        body,
      );
    }
  }
  await ctx.db.transaction(async (tx) => {
    await tx.execute("INSERT OR IGNORE INTO daily_insights VALUES(?,?,?)", [
      id,
      at,
      JSON.stringify(report),
    ]);
    const project = await one<{ retention_days: number }>(
      tx,
      "SELECT retention_days FROM products WHERE id=?",
      [id],
    );
    const cutoff = now - Math.min(366, project!.retention_days) * day;
    await tx.execute("DELETE FROM daily_insights WHERE product_id=? AND day_ms+86400000<=?", [
      id,
      cutoff,
    ]);
    await tx.execute("DELETE FROM notification_history WHERE product_id=? AND at_ms<?", [
      id,
      cutoff,
    ]);
  });
}
export async function nightlyTick(ctx: ApiContext) {
  const at = (Math.floor(+ctx.now() / day) - 1) * day;
  const projects = await all<{ id: string }>(
    ctx.db,
    "SELECT id FROM products WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM daily_insights d WHERE d.product_id=products.id AND day_ms=?)",
    [at],
  );
  for (const p of projects)
    try {
      await nightlyProject(ctx, p.id);
    } catch (e) {
      console.warn(
        `Daily insights deferred for ${p.id}`,
        e instanceof Error ? e.name : "query error",
      );
    }
}
export function registerInsights() {
  for (const prefix of ["/api/products/:project", "/api/read/products/:project"])
    route("POST", prefix + "/insights", READ, async (r, ctx, { project }) =>
      json(await insights(ctx, project!, await readJson(r))),
    );
}
