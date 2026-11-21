// Read routes for the Explore and Logs pages, on both the management and /api/read prefixes.
import { readJson } from "../api/body";
import { json } from "../api/errors";
import { READ, route } from "../api/router";
import { resolveProduct } from "../db/products";
import { requireSource } from "../db/sources";
import { parseEventsQuery, runEventsQuery } from "./events";
import { parseLogsQuery, runLogsQuery } from "./logs";
import { readAs } from "./read";
import { parseEntityQuery, runEntityQuery } from "./entities";
import { revenueReport } from "./revenue";
import { liveActivity } from "./activity";
import { customRules } from "./custom";
import { peopleList, personDetail } from "./people";
import { sessionList, sessionDetail, sessionSummary } from "./sessions";

export function registerQueries(): void {
  for (const prefix of ["/api/products/:project", "/api/read/products/:project"]) {
    for (const [path, run] of [
      ["query", peopleList],
      ["detail", personDetail],
    ] as const)
      route("POST", `${prefix}/people/${path}`, READ, async (req, ctx, { project }) =>
        json(await run(ctx, project as string, await readJson(req))),
      );
    route("POST", `${prefix}/activity`, READ, async (request, ctx, { project }) =>
      json(await liveActivity(ctx, project as string, await readJson(request))),
    );
    route("POST", `${prefix}/revenue/query`, READ, async (request, ctx, { project }) =>
      json(await revenueReport(ctx, project as string, await readJson(request))),
    );
    for (const kind of ["profiles", "groups"] as const)
      route("POST", `${prefix}/${kind}/query`, READ, async (request, ctx, { project }) => {
        const product = await resolveProduct(ctx.db, project as string);
        const query = parseEntityQuery(await readJson(request));
        return json(await readAs(ctx, product.id, (reader) => runEntityQuery(reader, kind, query)));
      });
    route("POST", `${prefix}/query`, READ, async (request, ctx, { project }) => {
      const product = await resolveProduct(ctx.db, project as string);
      const query = parseEventsQuery(await readJson(request));
      if (query.source_id) await requireSource(ctx.db, product.id, query.source_id);
      const rules = await customRules(ctx.db, product.id);
      return json(await readAs(ctx, product.id, (reader) => runEventsQuery(reader, query, rules)));
    });
    route("POST", `${prefix}/logs/query`, READ, async (request, ctx, { project }) => {
      const product = await resolveProduct(ctx.db, project as string);
      const query = parseLogsQuery(await readJson(request));
      if (query.source_id) await requireSource(ctx.db, product.id, query.source_id);
      return json(await readAs(ctx, product.id, (reader) => runLogsQuery(reader, query)));
    });
    for (const [path, run] of [
      ["query", sessionList],
      ["detail", sessionDetail],
      ["summary", sessionSummary],
    ] as const)
      route("POST", `${prefix}/sessions/${path}`, READ, async (request, ctx, { project }) =>
        json(await run(ctx, project as string, await readJson(request))),
      );
  }
}
