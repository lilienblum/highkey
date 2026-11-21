import type { ApiContext } from "./api/context";
import { fields, readJson } from "./api/body";
import { bad, json, noContent, ApiError } from "./api/errors";
import { route, READ } from "./api/router";
import { all, one, changes, type Db } from "./db/db";
import { newId } from "./db/ids";
import {
  type DestinationKind,
  type DeliveryConfig,
  type TemplateData,
  renderText,
  bodyTemplate,
  deliver,
  seal,
  unseal,
  hasEmailAccess,
} from "./delivery";
import { parseEventsQuery, predicate, parseFilters } from "./queries/events";
import { validEvent, customRules, namedEvent } from "./queries/custom";
import { Params } from "./queries/properties";
import { readAs } from "./queries/read";
import { runSettings } from "./clickhouse/access";
import { throttle } from "./dashboards/routes";
export type NotificationRule = {
  id: string;
  product_id: string;
  name: string;
  kind: string;
  template: string;
  definition: string;
  destination: string | null;
  cursor_ms: number;
  cursor_key: string;
  enabled: number;
};
type Rule = NotificationRule;
export type RuleSpec = { steps: string[]; filters: ReturnType<typeof parseFilters> };
type Target = {
  id: string;
  product_id: string;
  name: string;
  kind: DestinationKind;
  sealed: string;
};
export type Notice = {
  origin: string;
  ms: number;
  event_id: string | null;
  profile_id: string | null;
  source_id: string | null;
  event_ms: number | null;
  name: string;
  country: string;
  properties: Record<string, unknown>;
  email: string | null;
};
type History = {
  seq: number;
  rule_name: string;
  message: string;
  status: string;
  at_ms: number;
  event_id: string | null;
  source_id: string | null;
  event_ms: number | null;
  profile_id: string | null;
};
const historyCols = "seq,rule_name,message,status,at_ms,event_id,source_id,event_ms,profile_id";
export async function enqueueNotice(
  db: Db,
  rule: Pick<Rule, "id" | "product_id" | "name" | "template" | "destination">,
  row: Notice,
  at: number,
  body?: unknown,
) {
  const data: TemplateData = {
    name: row.name,
    country: row.country,
    properties: row.properties,
    profile: { id: row.profile_id, email: row.email },
  };
  const message = renderText(rule.template || "{{name}}", data);
  const payload = JSON.stringify(
    bodyTemplate(body ?? { text: "{{message}}" }, { ...data, message }),
  );
  const oversized = Buffer.byteLength(payload) > 65536;
  return changes(
    db,
    `INSERT OR IGNORE INTO notification_history(product_id,rule_id,rule_name,origin,at_ms,event_id,profile_id,source_id,event_ms,message,destination,payload,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      rule.product_id,
      rule.id,
      rule.name,
      row.origin,
      at,
      row.event_id,
      row.profile_id,
      row.source_id,
      row.event_ms,
      message,
      rule.destination,
      oversized ? "null" : payload,
      rule.destination ? (oversized ? "failed" : "pending") : "dashboard",
    ],
  );
}
export async function destinationBody(ctx: ApiContext, rule: Rule) {
  const dest = rule.destination
    ? await one<Target>(
        ctx.db,
        "SELECT * FROM notification_destinations WHERE product_id=? AND id=?",
        [rule.product_id, rule.destination],
      )
    : null;
  return dest ? unseal(ctx, dest.id, dest.sealed).body : undefined;
}
async function ruleBatch(ctx: ApiContext, rule: Rule) {
  const spec: RuleSpec = JSON.parse(rule.definition),
    p = new Params(),
    rules = await customRules(ctx.db, rule.product_id);
  const now = +ctx.now(),
    funnel = rule.kind === "funnel",
    end = now - (funnel ? 1800000 : 60000 / 4);
  const base = predicate(
    { filters: spec.filters } as ReturnType<typeof parseEventsQuery>,
    p,
    rules,
  );
  const names = spec.steps.map((n) => namedEvent(n, p, rules));
  const cursor = "(ms,origin)>({cursor:Int64},{key:String}) AND ms<{end:Int64}";
  const body = await destinationBody(ctx, rule);
  const email = /\{\{\s*profile\.email\s*\}\}/.test(rule.template + JSON.stringify(body ?? null));
  const contact = email
    ? "LEFT JOIN (SELECT profile_id,argMaxIf(traits.email.:String,tuple(event_time,event_id),isNotNull(traits.email.:String)) AS email FROM profile_records GROUP BY profile_id) p ON p.profile_id=e.profile_id"
    : "";
  const cols = `e.event_id AS event_id,e.profile_id AS profile_id,e.source_id AS source_id,toUnixTimestamp64Milli(e.event_time) AS event_ms,e.name AS name,e.country AS country,e.properties AS properties,${email ? "p.email" : "''"} AS email`;
  // One path per visit: its earliest matching first step, then the nearest strictly later
  // match for each next step. A later unrelated event is never the linked completion.
  const last = `s${names.length - 1}`;
  const query = funnel
    ? `WITH closed AS (SELECT source_id,actor_id,session_id,toUnixTimestamp64Milli(ended_at) AS ms,toJSONString(tuple(source_id,actor_id,session_id)) AS origin FROM sessions WHERE ${cursor}),
    candidates AS (SELECT c.origin AS visit,c.ms AS closed_ms,e.event_id AS eid,row_number() OVER (PARTITION BY visit ORDER BY e.event_time,e.event_id) AS pos,${names.map((n, i) => `(${n}) AS step${i}`).join(",")}
    FROM all_events e INNER JOIN closed c ON c.source_id=e.source_id AND c.actor_id=e.actor_id AND c.session_id=e.session_id WHERE NOT e.backfill AND ${base}),
    starts AS (SELECT visit,closed_ms,min(pos) AS pos FROM candidates WHERE step0 GROUP BY visit,closed_ms)
    SELECT s0.closed_ms AS ms,s0.visit AS origin,${cols} FROM starts s0
    ${names
      .slice(1)
      .map(
        (_, i) =>
          `ASOF INNER JOIN (SELECT visit,pos,eid FROM candidates WHERE step${i + 1}) s${i + 1} ON s${i}.visit=s${i + 1}.visit AND s${i}.pos<s${i + 1}.pos`,
      )
      .join(" ")}
    INNER JOIN all_events e ON ${last}.eid=e.event_id ${contact} ORDER BY ms,origin LIMIT 100`
    : `SELECT toUnixTimestamp64Milli(e.received_at) AS ms,e.event_id AS origin,${cols} FROM all_events e ${contact} WHERE ${cursor} AND (${names[0]}) AND ${base} ORDER BY ms,origin LIMIT 100`;
  const rows = (
    await readAs(ctx, rule.product_id, (r) =>
      r.query<Notice>(query, {
        params: { ...p.values, key: rule.cursor_key, cursor: rule.cursor_ms, end },
        settings: runSettings({ from: new Date(0), to: ctx.now(), bucket: "day", source: null }),
      }),
    )
  ).data;
  const n = await ctx.db.transaction(async (tx) => {
    const last = rows.at(-1),
      full = rows.length === 100;
    if (
      !(await changes(
        tx,
        "UPDATE notification_rules SET cursor_ms=?,cursor_key=? WHERE id=? AND enabled=1 AND cursor_ms=? AND cursor_key=?",
        [full ? last!.ms : end, full ? last!.origin : "", rule.id, rule.cursor_ms, rule.cursor_key],
      ))
    )
      return 0;
    let count = 0;
    for (const row of rows) count += await enqueueNotice(tx, rule, row, now, body);
    return count;
  });
  if (n) ctx.changes.notify(rule.product_id, "events");
}
export async function notifyTick(ctx: ApiContext, send = deliver) {
  const rules = await all<Rule>(
    ctx.db,
    "SELECT r.* FROM notification_rules r JOIN products p ON r.product_id=p.id WHERE r.enabled=1 AND r.kind IN ('event','funnel') AND p.deleted_at IS NULL",
  );
  for (const rule of rules)
    if (rule.cursor_ms < +ctx.now() - (rule.kind === "funnel" ? 1800000 : 15000))
      try {
        await ruleBatch(ctx, rule);
      } catch {
        console.warn(`Notification rule ${rule.id} will retry`);
      }
  const now = +ctx.now();
  const due = await all<
    Target & { seq: number; message: string; payload: string; attempts: number }
  >(
    ctx.db,
    "SELECT d.*,h.seq,h.message,h.payload,h.attempts FROM notification_history h JOIN notification_destinations d ON h.destination=d.id AND h.product_id=d.product_id JOIN products p ON h.product_id=p.id WHERE p.deleted_at IS NULL AND h.status='pending' AND h.next_ms<=? ORDER BY h.seq LIMIT 32",
    [now],
  );
  for (const row of due) {
    if (
      !(await changes(
        ctx.db,
        "UPDATE notification_history SET next_ms=?,attempts=attempts+1 WHERE seq=? AND status='pending' AND next_ms<=?",
        [now + 120000, row.seq, now],
      ))
    )
      continue;
    let status = "sent";
    try {
      await send(
        ctx,
        row.product_id,
        row.kind,
        unseal(ctx, row.id, row.sealed),
        `${row.product_id}-${row.seq}`,
        row.message,
        JSON.parse(row.payload),
      );
    } catch {
      status = row.attempts >= 6 ? "failed" : "pending";
    }
    await ctx.db.execute(
      "UPDATE notification_history SET status=?,next_ms=? WHERE seq=? AND attempts=?",
      [status, now + Math.min(3600000, 15000 * 2 ** row.attempts), row.seq, row.attempts + 1],
    );
  }
  return rules.length || due.length;
}
export async function notificationHistory(
  ctx: ApiContext,
  id: string,
  before = Number.MAX_SAFE_INTEGER,
) {
  return all<History>(
    ctx.db,
    `SELECT ${historyCols} FROM notification_history WHERE product_id=? AND seq<? ORDER BY seq DESC LIMIT 50`,
    [id, before],
  );
}
export function registerNotifications() {
  const root = "/api/products/:project/notifications";
  for (const prefix of [root, "/api/read/products/:project/notifications"])
    route("GET", prefix + "/history", READ, async (r, ctx, { project }) => {
      const before = Number(new URL(r.url).searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) throw bad("Invalid notification cursor");
      return json(await notificationHistory(ctx, project!, before));
    });
  route("GET", root + "/config", { project: ["update"] }, async (_r, ctx, { project }) =>
    json({
      destinations: await all(
        ctx.db,
        "SELECT id,name,kind FROM notification_destinations WHERE product_id=? ORDER BY name",
        [project!],
      ),
      rules: (
        await all<Rule>(
          ctx.db,
          "SELECT * FROM notification_rules WHERE product_id=? ORDER BY name",
          [project!],
        )
      ).map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        enabled: !!r.enabled,
        destination: r.destination,
        spec: JSON.parse(r.definition),
        template: r.template,
      })),
    }),
  );
  route("POST", root + "/destinations", { project: ["update"] }, async (r, ctx, { project }) => {
    const q = fields(
      await readJson(r),
      {
        kind: "string",
        name: "string",
        url: "string",
        email: "string",
        headers: "unknown",
        body: "unknown",
      },
      { url: "", email: "", headers: {}, body: { text: "{{message}}" } },
    );
    if (
      !["slack", "discord", "webhook", "email"].includes(q.kind) ||
      !q.name.trim() ||
      q.name.length > 80 ||
      !q.headers ||
      typeof q.headers !== "object" ||
      Array.isArray(q.headers) ||
      Object.keys(q.headers).length > 12 ||
      JSON.stringify(q.body).length > 4096
    )
      throw bad("Invalid delivery configuration");
    if (q.kind === "email") {
      if (!(await hasEmailAccess(ctx, project!, q.email)))
        throw bad("Choose the email address of a current member with project access");
    } else {
      let url: URL;
      try {
        url = new URL(q.url);
      } catch {
        throw bad("Use an HTTPS webhook URL");
      }
      if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        url.username ||
        url.password ||
        url.hash ||
        q.url.length > 2048 ||
        (q.kind === "slack" && url.hostname !== "hooks.slack.com") ||
        (q.kind === "discord" && url.hostname !== "discord.com")
      )
        throw bad("Use a public HTTPS URL for the selected provider");
    }
    const headers = Object.entries(q.headers);
    if (
      headers.some(
        ([k, v]) =>
          !/^([a-z0-9-]{1,64})$/i.test(k) ||
          /^(host|connection|content-length|content-type|transfer-encoding|proxy-.*|cookie|expect|upgrade|te|trailer)$/i.test(
            k,
          ) ||
          typeof v !== "string" ||
          v.length > 2048 ||
          /[^\x20-\x7e]/.test(v),
      )
    )
      throw bad("Invalid webhook headers");
    throttle(ctx, project!);
    const id = newId();
    await ctx.db.execute(
      "INSERT INTO notification_destinations(id,product_id,name,kind,sealed) VALUES(?,?,?,?,?)",
      [
        id,
        project!,
        q.name.trim(),
        q.kind,
        seal(ctx, id, {
          url: q.url,
          email: q.email,
          headers: Object.fromEntries(headers),
          body: q.body,
        }),
      ],
    );
    return json({ id, name: q.name.trim(), kind: q.kind });
  });
  route("POST", root + "/rules", { project: ["update"] }, async (r, ctx, { project }) => {
    const q = fields(
      await readJson(r),
      {
        name: "string",
        kind: "string",
        steps: "string[]",
        filters: "unknown",
        template: "string",
        destination: "string?",
      },
      { steps: [], template: "" },
    );
    if (
      !q.name.trim() ||
      q.name.length > 80 ||
      q.template.length > 1024 ||
      !["event", "funnel", "health", "digest"].includes(q.kind) ||
      q.steps.length > 8 ||
      !q.steps.every(validEvent) ||
      (q.kind === "event" && q.steps.length !== 1) ||
      (q.kind === "funnel" && q.steps.length < 2)
    )
      throw bad("Provide a bounded rule name, valid event steps and template");
    if (
      q.destination &&
      !(await one(ctx.db, "SELECT id FROM notification_destinations WHERE product_id=? AND id=?", [
        project!,
        q.destination,
      ]))
    )
      throw bad("Unknown project destination");
    const params = new Params(),
      rules = await customRules(ctx.db, project!),
      filters = parseFilters(q.filters);
    if (filters.length > 8) throw bad("Use at most eight filters");
    predicate({ filters } as ReturnType<typeof parseEventsQuery>, params, rules);
    q.steps.forEach((n) => namedEvent(n, params, rules));
    const id = newId();
    throttle(ctx, project!);
    await ctx.db.execute(
      "INSERT INTO notification_rules(id,product_id,name,kind,definition,template,destination,cursor_ms) VALUES(?,?,?,?,?,?,?,?)",
      [
        id,
        project!,
        q.name.trim(),
        q.kind,
        JSON.stringify({ steps: q.steps, filters }),
        q.template,
        q.destination || null,
        +ctx.now(),
      ],
    );
    return json({ id });
  });
  for (const [name, table] of [
    ["rules", "notification_rules"],
    ["destinations", "notification_destinations"],
  ])
    route(
      "DELETE",
      `${root}/${name}/:key`,
      { project: ["update"] },
      async (_r, ctx, { project, key }) => {
        if (
          name === "destinations" &&
          (await one(
            ctx.db,
            "SELECT 1 FROM notification_rules WHERE destination=? AND product_id=?",
            [key!, project!],
          ))
        )
          throw bad("Remove rules using this destination first");
        if (
          !(await changes(ctx.db, `DELETE FROM ${table} WHERE product_id=? AND id=?`, [
            project!,
            key!,
          ]))
        )
          throw new ApiError(404, "Not found");
        if (name === "destinations")
          await ctx.db.execute(
            "UPDATE notification_history SET status='cancelled' WHERE product_id=? AND destination=? AND status='pending'",
            [project!, key!],
          );
        return noContent();
      },
    );
}
