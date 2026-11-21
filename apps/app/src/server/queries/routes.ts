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

export function registerQueries(): void {
  for (const prefix of ["/api/products/:project", "/api/read/products/:project"]) {
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
      return json(await readAs(ctx, product.id, (reader) => runEventsQuery(reader, query)));
    });
    route("POST", `${prefix}/logs/query`, READ, async (request, ctx, { project }) => {
      const product = await resolveProduct(ctx.db, project as string);
      const query = parseLogsQuery(await readJson(request));
      if (query.source_id) await requireSource(ctx.db, product.id, query.source_id);
      return json(await readAs(ctx, product.id, (reader) => runLogsQuery(reader, query)));
    });
  }
}
