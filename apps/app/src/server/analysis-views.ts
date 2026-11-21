import { fields, readJson } from "./api/body";
import { bad, json, noContent, ApiError } from "./api/errors";
import { READ, route } from "./api/router";
import { all, one, changes } from "./db/db";
import { newId } from "./db/ids";
import { analysisSpec } from "./queries/analysis";
import { throttle } from "./dashboards/routes";
export function registerAnalysisViews() {
  for (const path of ["/api/products/:project", "/api/read/products/:project"])
    route("GET", path + "/analysis-views", READ, async (_r, ctx, { project }) =>
      json(
        (
          await all<{ id: string; name: string; definition: string }>(
            ctx.db,
            "SELECT id,name,definition FROM analysis_views WHERE product_id=? ORDER BY name",
            [project!],
          )
        ).map(({ definition, ...v }) => ({ ...v, spec: JSON.parse(definition) })),
      ),
    );
  route(
    "POST",
    "/api/products/:project/analysis-views",
    { dashboard: ["write"] },
    async (r, ctx, { project }) => {
      const q = fields(await readJson(r), { name: "string", spec: "unknown", id: "string?" }),
        name = q.name.trim(),
        spec = analysisSpec(q.spec);
      if (!name || name.length > 80 || JSON.stringify(spec).length > 8192)
        throw bad("Use a view name of 1–80 characters and a definition under 8 KiB");
      throttle(ctx, project!);
      const id = q.id ?? newId();
      await ctx.db.transaction(async (tx) => {
        if (
          q.id &&
          !(await one(tx, "SELECT 1 FROM analysis_views WHERE product_id=? AND id=?", [
            project!,
            id,
          ]))
        )
          throw new ApiError(404, "Analysis view not found");
        if (
          await one(tx, "SELECT 1 FROM analysis_views WHERE product_id=? AND name=? AND id!=?", [
            project!,
            name,
            id,
          ])
        )
          throw bad("An analysis view already uses that name");
        if (
          !q.id &&
          Number(
            (
              await one<{ n: number }>(
                tx,
                "SELECT count(*) AS n FROM analysis_views WHERE product_id=?",
                [project!],
              )
            )?.n,
          ) >= 100
        )
          throw bad("A project holds at most 100 analysis views");
        await tx.execute(
          "INSERT INTO analysis_views(id,product_id,name,definition) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition=excluded.definition",
          [id, project!, name, JSON.stringify(spec)],
        );
      });
      ctx.changes.notify(project!, "dashboards");
      return json({ id, name, spec });
    },
  );
  route(
    "DELETE",
    "/api/products/:project/analysis-views/:view",
    { dashboard: ["write"] },
    async (_r, ctx, { project, view }) => {
      if (
        !(await changes(ctx.db, "DELETE FROM analysis_views WHERE product_id=? AND id=?", [
          project!,
          view!,
        ]))
      )
        throw new ApiError(404, "Analysis view not found");
      ctx.changes.notify(project!, "dashboards");
      return noContent();
    },
  );
}
