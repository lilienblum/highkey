import { fields, readJson } from "./api/body";
import type { ApiContext } from "./api/context";
import { ApiError, bad, json, noContent } from "./api/errors";
import { route, READ } from "./api/router";
import { all, one } from "./db/db";
import { newId } from "./db/ids";
import { readAs } from "./queries/read";
import { runSettings } from "./clickhouse/access";
import { customRules, namedEvent, validEvent } from "./queries/custom";
import { Params, filterCondition, validKey } from "./queries/properties";
import { supportedOp } from "../lib/filter-ops";
import { throttle } from "./dashboards/routes";

type EventRule = {
  event: string;
  days: number;
  compare: "at_least" | "exactly" | "at_most";
  count: number;
};
type TraitRule = { property: string; op: string; value?: string | number | boolean };
export type CohortDefinition =
  | { mode: "static"; members: string[] }
  | { mode: "dynamic"; match: "all" | "any"; rules: (EventRule | TraitRule)[] };
export interface Cohort {
  id: string;
  name: string;
  definition: CohortDefinition;
  revision: number;
  checked_at: number | null;
  member_count: number;
}
type Row = Omit<Cohort, "definition"> & { product_id: string; definition: string };
const decode = ({ product_id: _, definition, ...r }: Row): Cohort => ({
  ...r,
  definition: JSON.parse(definition),
});
export const listCohorts = async (ctx: ApiContext, id: string) =>
  (await all<Row>(ctx.db, "SELECT * FROM cohorts WHERE product_id=? ORDER BY name", [id])).map(
    decode,
  );
function definition(input: unknown): CohortDefinition {
  if ((input as { mode?: string })?.mode === "static") {
    const q = fields(input, { mode: "string", members: "string[]" });
    if (
      q.members.length > 5000 ||
      q.members.some((v) => !v || new TextEncoder().encode(v).length > 128)
    )
      throw bad("Use up to 5,000 profile IDs of 1–128 bytes");
    return { mode: "static", members: [...new Set(q.members)].sort() };
  }
  const q = fields(input, { mode: "string", match: "string", rules: "unknown" });
  if (
    q.mode !== "dynamic" ||
    (q.match !== "all" && q.match !== "any") ||
    !Array.isArray(q.rules) ||
    !q.rules.length ||
    q.rules.length > 8
  )
    throw bad("Choose all or any of 1–8 dynamic rules");
  return {
    mode: "dynamic",
    match: q.match,
    rules: q.rules.map((raw) => {
      if (typeof raw === "object" && raw !== null && "event" in raw) {
        const v = fields(raw, {
          event: "string",
          days: "integer",
          compare: "string",
          count: "integer",
        });
        if (
          !validEvent(v.event) ||
          v.days < 7 ||
          v.days > 365 ||
          v.count < 0 ||
          v.count > 1000000 ||
          !["at_least", "at_most", "exactly"].includes(v.compare)
        )
          throw bad("Invalid cohort event threshold or window (7–365 days)");
        return v as EventRule;
      }
      const v = fields(raw, { property: "string", op: "string", value: "unknown" });
      if (
        !validKey(v.property) ||
        !supportedOp(v.op) ||
        (v.value != null && !["string", "number", "boolean"].includes(typeof v.value)) ||
        String(v.value ?? "").length > 512
      )
        throw bad("Invalid profile trait filter");
      filterCondition("value", v.op, v.value, new Params());
      return v as TraitRule;
    }),
  };
}
async function calculate(ctx: ApiContext, id: string, d: CohortDefinition, time: Date) {
  if (d.mode === "static") return d.members;
  const p = new Params(),
    custom = await customRules(ctx.db, id);
  const conditions = d.rules.map((rule, i) => {
    if ("event" in rule) {
      const op = { at_least: ">=", exactly: "=", at_most: "<=" }[rule.compare];
      return {
        aggregate: `countIf(event_time>=fromUnixTimestamp64Milli(${p.add("Int64", +time - rule.days * 86400000)}) AND ${namedEvent(rule.event, p, custom)}) AS n${i}`,
        test: `ifNull(n${i},0) ${op} ${p.add("UInt32", rule.count)}`,
      };
    }
    const key = p.add("String", rule.property);
    const value = `JSONExtract(ifNull(nullIf(traits[${key}],''),'null'),'Dynamic')`;
    return { test: filterCondition(value, rule.op, rule.value, p) };
  });
  const expr = conditions.flatMap((c) => (c.aggregate ? [c.aggregate] : [])).join(","),
    where = conditions.map((c) => `(${c.test})`).join(d.match === "all" ? " AND " : " OR ");
  const sql = `WITH counts AS (SELECT assumeNotNull(profile_id) AS id${expr ? "," + expr : ""} FROM profile_events WHERE profile_id IS NOT NULL GROUP BY profile_id),
 traits_by_id AS (SELECT assumeNotNull(first.1) AS id,arrayFold((m,row)->highkey_apply_traits(m,row.3,row.4),arraySort(row->(row.1,row.2),groupArray(tuple(first.2,event_id,first.3,first.4))),CAST(map(),'Map(String,String)')) AS traits
 FROM (SELECT event_id,argMin(tuple(profile_id,event_time,toJSONString(traits),toJSONString(increments)),received_at) AS first FROM profile_records WHERE event_time<fromUnixTimestamp64Milli({end:Int64}) GROUP BY event_id) GROUP BY id)
 SELECT coalesce(nullIf(c.id,''),t.id) AS person FROM counts c FULL JOIN traits_by_id t USING(id) WHERE ${where} ORDER BY person LIMIT 100001`;
  const members = await readAs(ctx, id, (r) =>
    r.query<{ person: string }>(sql, {
      settings: runSettings({ from: new Date(0), to: time, source: null, bucket: "day" }),
      params: { ...p.values, end: +time },
    }),
  );
  if (members.rows > 100000) throw bad("Cohort exceeds 100,000 members; narrow its rules");
  return members.data.map((r) => r.person);
}
export async function refreshCohort(
  ctx: ApiContext,
  id: string,
  c: Cohort,
  at = ctx.now(),
  precomputed?: string[],
) {
  const members = precomputed ?? (await calculate(ctx, id, c.definition, at));
  await ctx.admin.insert("highkey.cohort_snapshots", [
    { product_id: id, cohort_id: c.id, revision: c.revision, computed_ms: +at, members },
  ]);
  await ctx.db.execute(
    "UPDATE cohorts SET checked_at=?,member_count=? WHERE product_id=? AND id=? AND revision=? AND (checked_at IS NULL OR checked_at<=?)",
    [+at, members.length, id, c.id, c.revision, +at],
  );
  ctx.changes.notify(id, "events");
}
export async function refreshDueCohorts(ctx: ApiContext) {
  const rows = await all<Row>(
    ctx.db,
    "SELECT c.* FROM cohorts c JOIN products p ON c.product_id=p.id WHERE p.deleted_at IS NULL AND (c.checked_at IS NULL OR (json_extract(c.definition,'$.mode')='dynamic' AND c.checked_at<=?)) ORDER BY c.checked_at,c.id",
    [+ctx.now() - 1800000],
  );
  for (const r of rows)
    try {
      await refreshCohort(ctx, r.product_id, decode(r));
    } catch {
      console.warn(`Cohort ${r.id} could not refresh; retrying next reconcile`);
    }
}
export function registerCohorts() {
  for (const prefix of ["/api/products/:project", "/api/read/products/:project"])
    route("GET", `${prefix}/cohorts`, READ, async (_r, ctx, { project }) =>
      json(await listCohorts(ctx, project!)),
    );
  route(
    "POST",
    "/api/products/:project/cohorts",
    { dashboard: ["write"] },
    async (r, ctx, { project }) => {
      const q = fields(await readJson(r), { name: "string", definition: "unknown", id: "string?" }),
        d = definition(q.definition),
        name = q.name.trim(),
        id = q.id ?? newId();
      if (!name || name.length > 80) throw bad("Cohort names must be 1–80 characters");
      throttle(ctx, project!);
      // Validate custom events and materialize the proposed definition before changing a saved one.
      const at = ctx.now(),
        members = await calculate(ctx, project!, d, at);
      const rev = await ctx.db.transaction(async (tx) => {
        const prev = await one<Row>(tx, "SELECT * FROM cohorts WHERE product_id=? AND id=?", [
          project!,
          id,
        ]);
        if (q.id && !prev) throw new ApiError(404, "Cohort not found");
        if (
          await one(tx, "SELECT 1 FROM cohorts WHERE product_id=? AND name=? AND id!=?", [
            project!,
            name,
            id,
          ])
        )
          throw bad("Cohort name already used");
        if (
          !prev &&
          Number(
            (
              await one<{ n: number }>(tx, "SELECT count(*) AS n FROM cohorts WHERE product_id=?", [
                project!,
              ])
            )?.n,
          ) >= 100
        )
          throw bad("A project holds at most 100 cohorts");
        const revision = (prev?.revision ?? 0) + 1;
        await tx.execute(
          "INSERT INTO cohorts(id,product_id,name,definition,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition=excluded.definition,revision=excluded.revision,checked_at=NULL",
          [id, project!, name, JSON.stringify(d), revision],
        );
        return revision;
      });
      await refreshCohort(
        ctx,
        project!,
        {
          id,
          name,
          definition: d,
          revision: rev,
          checked_at: null,
          member_count: 0,
        },
        at,
        members,
      );
      return json({ id, name });
    },
  );
  route(
    "DELETE",
    "/api/products/:project/cohorts/:cohort",
    { dashboard: ["write"] },
    async (_r, ctx, { project, cohort }) => {
      const row = await one<Row>(ctx.db, "SELECT * FROM cohorts WHERE id=? AND product_id=?", [
        cohort!,
        project!,
      ]);
      if (!row) throw new ApiError(404, "Cohort not found");
      await ctx.admin.insert("highkey.cohort_snapshots", [
        {
          product_id: project!,
          cohort_id: cohort!,
          revision: 4294967295,
          computed_ms: +ctx.now(),
          members: [],
        },
      ]);
      await ctx.db.execute("DELETE FROM cohorts WHERE product_id=? AND id=?", [project!, cohort!]);
      ctx.changes.notify(project!, "events");
      return noContent();
    },
  );
}
