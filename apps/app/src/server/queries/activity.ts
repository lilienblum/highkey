import { fields } from "../api/body";
import type { ApiContext } from "../api/context";
import { runSettings } from "../clickhouse/access";
import { requireSource } from "../db/sources";
import { parseEventsQuery, predicate } from "./events";
import { Params } from "./properties";
import { readAs } from "./read";

/** Thirty adjacent one-minute windows ending at `to`, plus the distinct actors over the last five. */
export async function liveActivity(ctx: ApiContext, project: string, body: unknown) {
  const q = fields(body, {
    to: "string",
    event: "string?",
    source: "string?",
    source_id: "string?",
    filters: "unknown",
  });
  // parseEventsQuery validates the supplied timestamp before it is used in a setting.
  const end = Date.parse(q.to);
  const query = parseEventsQuery({
    ...q,
    from: Number.isFinite(end) ? new Date(end - 1800000).toISOString() : "",
  });
  if (q.source_id != null) await requireSource(ctx.db, project, q.source_id);
  const params = new Params(),
    where = predicate(query, params);
  const result = await readAs(ctx, project, (r) =>
    r.query<{ slot: number; is_total: number; actors: number; recent: number; activity: number }>(
      `SELECT intDiv(toUnixTimestamp64Milli(event_time)-{start:Int64},60000) AS slot,grouping(slot) AS is_total,
      uniqExactIf((identity_kind,actor_id),actor_id IS NOT NULL) AS actors,
      uniqExactIf((identity_kind,actor_id),actor_id IS NOT NULL AND event_time >= fromUnixTimestamp64Milli({recent:Int64})) AS recent,
      countIf(event_time >= fromUnixTimestamp64Milli({recent:Int64})) AS activity
    FROM events WHERE ${where} GROUP BY GROUPING SETS ((slot), ())`,
      {
        settings: runSettings({ ...query, source: q.source_id ?? null }),
        params: { ...params.values, start: +query.from, recent: end - 300000 },
      },
    ),
  );
  const total = result.data.find((row) => Number(row.is_total) === 1);
  const minutes = Array<number>(30).fill(0);
  for (const row of result.data)
    if (!Number(row.is_total)) minutes[Number(row.slot)] = Number(row.actors);
  return { active: Number(total?.recent ?? 0), events: Number(total?.activity ?? 0), minutes };
}
