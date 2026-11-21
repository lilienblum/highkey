import { fields, readJson } from "./api/body";
import { type ApiContext } from "./api/context";
import { ApiError, bad, json, noContent } from "./api/errors";
import { READ, route } from "./api/router";
import { all, changes } from "./db/db";
import { newId } from "./db/ids";
import { throttle } from "./dashboards/routes";
import { readAs } from "./queries/read";
import { parseEventsQuery } from "./queries/events";
import { runSettings } from "./clickhouse/access";
import { insights } from "./insights";

export interface ChartReference {
  id: string;
  title: string;
  description: string;
  at: number;
  kind: "note" | "deploy" | "version" | "insight";
}
export async function createReference(ctx: ApiContext, project: string, body: unknown) {
  const q = fields(
    body,
    { title: "string", description: "string", at: "string" },
    { description: "" },
  );
  const at = Date.parse(q.at),
    title = q.title.trim(),
    description = q.description.trim();
  if (
    !title ||
    title.length > 120 ||
    description.length > 1000 ||
    !Number.isFinite(at) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(q.at)
  )
    throw bad(
      "Provide a title of 1–120 characters, a description up to 1,000 characters and a timestamp with a timezone",
    );
  throttle(ctx, project);
  const id = newId();
  await ctx.db.execute(
    "INSERT INTO chart_references(id,product_id,at_ms,title,description) VALUES(?,?,?,?,?)",
    [id, project, at, title, description],
  );
  ctx.changes.notify(project, "dashboards");
  return { id, at, title, description, kind: "note" as const };
}
export async function listReferences(ctx: ApiContext, project: string, body: unknown) {
  const q = fields(body, { from: "string", to: "string" });
  const { from, to } = parseEventsQuery(q),
    limit = 250;
  const notes = await all<ChartReference>(
    ctx.db,
    `SELECT id,at_ms AS at,title,description,'note' AS kind FROM chart_references WHERE product_id=? AND at_ms>=? AND at_ms<? ORDER BY at_ms DESC,id LIMIT ?`,
    [project, +from, +to, limit + 1],
  );
  // Find first sightings in retained project history, not merely in the date selection. Only
  // versions appearing in this range can have a first sighting here.
  const version = "properties.version.:String";
  const auto = await readAs(ctx, project, (r) =>
    r.query<ChartReference>(
      `SELECT * FROM (
    SELECT concat('deploy:',event_id) AS id,toUnixTimestamp64Milli(event_time) AS at,
      if(empty(ifNull(${version},'')),'Deployment',concat('Deploy ',leftUTF8(${version},80))) AS title,'' AS description,'deploy' AS kind
    FROM events WHERE name IN ('deploy','deployment') AND NOT backfill
    UNION ALL
    SELECT concat('version:',${version}) AS id,toUnixTimestamp64Milli(min(event_time)) AS at,concat('CLI ',${version}) AS title,
      'First seen in retained project history' AS description,'version' AS kind FROM all_events
    WHERE source='cli' AND NOT backfill AND ${version} IN (SELECT ${version} FROM events WHERE source='cli' AND NOT backfill AND match(${version},'^v?[0-9][0-9A-Za-z.+_-]{0,63}$'))
    GROUP BY ${version} HAVING at >= {start:Int64} AND at < {end:Int64}
  ) ORDER BY at DESC,id LIMIT {size:UInt32}`,
      {
        settings: runSettings({ from, to, source: null, bucket: "day" }),
        params: { start: +from, end: +to, size: limit + 1 },
      },
    ),
  );
  const markers = (await insights(ctx, project, q)).map((t) => ({
    id: JSON.stringify([t.at, t.dimension, t.days, t.label]),
    at: t.at,
    title: t.title,
    description: `${t.severity} · ${t.description}`,
    kind: "insight" as const,
  }));
  const rows = [...notes, ...auto.data, ...markers].sort(
    (a, b) => b.at - a.at || a.id.localeCompare(b.id),
  );
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
export function registerReferences() {
  for (const prefix of ["/api/products/:project", "/api/read/products/:project"])
    route("POST", `${prefix}/references/query`, READ, async (r, ctx, { project }) =>
      json(await listReferences(ctx, project!, await readJson(r))),
    );
  route(
    "POST",
    "/api/products/:project/references",
    { dashboard: ["write"] },
    async (r, ctx, { project }) => json(await createReference(ctx, project!, await readJson(r))),
  );
  route(
    "DELETE",
    "/api/products/:project/references/:reference",
    { dashboard: ["write"] },
    async (_r, ctx, { project, reference }) => {
      if (
        !(await changes(ctx.db, "DELETE FROM chart_references WHERE product_id=? AND id=?", [
          project!,
          reference!,
        ]))
      )
        throw new ApiError(404, "Reference not found");
      ctx.changes.notify(project!, "dashboards");
      return noContent();
    },
  );
}
