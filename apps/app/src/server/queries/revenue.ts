import { fields } from "../api/body";
import { bad } from "../api/errors";
import type { ApiContext } from "../api/context";
import { runSettings } from "../clickhouse/access";
import { requireSource } from "../db/sources";
import { readAs } from "./read";
import { parseEventsQuery, predicate } from "./events";
import { Params } from "./properties";

const dimensions = new Map([
  ["source", "toString(source_id)"],
  ["page", "nullIf(dynamicElement(properties.path, 'String'), '')"],
  ["profile", "profile_id"],
  ["session", "session_id"],
]);

export async function revenueReport(ctx: ApiContext, project: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      group_by: "string",
      page: "integer",
      page_size: "integer",
      event: "string?",
      source: "string?",
      filters: "unknown",
    },
    { group_by: "source", page: 1, page_size: 25 },
  );
  const query = parseEventsQuery({
    from: q.from,
    to: q.to,
    event: q.event,
    source: q.source,
    filters: q.filters,
  });
  const params = new Params();
  const where = predicate(query, params);
  const dimension = dimensions.get(q.group_by);
  if (!dimension) throw bad("Group revenue by source, page, profile or session");
  if (q.page < 1 || q.page > 10000 || q.page_size < 1 || q.page_size > 100)
    throw bad("Use page 1–10000 and page_size 1–100");
  if (q.source_id != null) await requireSource(ctx.db, project, q.source_id);
  return readAs(ctx, project, async (reader) => {
    // Only integer cents count (older events allowed arbitrary properties). Keep values
    // and totals out of Float64, including when a sum exceeds JS's safe integer range.
    const result = await reader.query<{
      label: string | null;
      cents: string;
      revenue_events: number;
      is_total: number;
      group_count: number;
    }>(
      `WITH attributed AS (
      SELECT ${dimension} AS label, coalesce(toInt128(dynamicElement(properties.revenue, 'Int64')), toInt128(dynamicElement(properties.revenue, 'UInt64'))) AS amount
      FROM events WHERE (${where}) AND amount BETWEEN -9007199254740991 AND 9007199254740991
    ), grouped AS (
      SELECT label, grouping(label) AS is_total, sum(amount) AS net, count() AS n
      FROM attributed GROUP BY GROUPING SETS ((label), ())
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY is_total ORDER BY net DESC, label ASC NULLS LAST) AS pos,
        countIf(is_total = 0) OVER () AS group_count FROM grouped
    )
    SELECT label, is_total, toString(ifNull(net,0)) AS cents, n AS revenue_events, group_count FROM ranked
    WHERE is_total = 1 OR pos BETWEEN {start:UInt32} AND {end:UInt32}
    ORDER BY is_total DESC, pos`,
      {
        settings: runSettings({
          from: query.from,
          to: query.to,
          source: q.source_id ?? null,
          bucket: "day",
        }),
        params: {
          ...params.values,
          start: (q.page - 1) * q.page_size + 1,
          end: q.page * q.page_size,
        },
      },
    );
    const summary = result.data.find((row) => Number(row.is_total) === 1);
    return {
      cents: summary?.cents ?? "0",
      revenue_events: Number(summary?.revenue_events ?? 0),
      groups: Number(summary?.group_count ?? 0),
      page: q.page,
      page_size: q.page_size,
      rows: result.data
        .filter((row) => !Number(row.is_total))
        .map((row) => ({
          label: row.label,
          cents: row.cents,
          revenue_events: Number(row.revenue_events),
        })),
    };
  });
}
