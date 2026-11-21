import { fields } from "../api/body";
import { bad } from "../api/errors";
import type { ApiContext } from "../api/context";
import { runSettings } from "../clickhouse/access";
import { requireSource } from "../db/sources";
import { parseEventsQuery } from "./events";
import { numeric } from "./properties";
import { readAs } from "./read";

export async function generations(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      source_id: "string?",
      group_by: "string",
      trace_id: "string?",
      page: "integer",
      page_size: "integer",
    },
    { group_by: "model", page: 1, page_size: 25 },
  );
  const { from, to } = parseEventsQuery({ from: q.from, to: q.to });
  const dimension = new Map([
    ["model", "properties.model.:String"],
    ["feature", "properties.feature.:String"],
    ["profile", "profile_id"],
  ]).get(q.group_by);
  if (
    !dimension ||
    q.page < 1 ||
    q.page > 10000 ||
    q.page_size < 1 ||
    q.page_size > 100 ||
    (q.trace_id != null && (!q.trace_id || new TextEncoder().encode(q.trace_id).length > 128))
  )
    throw bad(
      "Use a model, feature or profile breakdown, a trace ID of 1–128 bytes and a valid page",
    );
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  const options = {
    settings: runSettings({ from, to, bucket: "day", source: q.source_id ?? null }),
    params: { trace: q.trace_id ?? "", size: q.page_size, offset: (q.page - 1) * q.page_size },
  };
  const cost = numeric("properties.cost");
  const base = `WITH if(properties.currency.:String='USD' AND ${cost}>=0,${cost},NULL) AS usd`;
  const where = `FROM profile_events WHERE name='ai_generation' AND ({trace:String}='' OR properties.trace_id.:String={trace:String})`;
  return readAs(ctx, id, async (reader) => {
    const summary = (
      await reader.query<{
        calls: number;
        priced: number;
        cost_usd: number | null;
        errors: number;
      }>(
        `${base} SELECT count() AS calls,count(usd) AS priced,sumOrNull(usd) AS cost_usd,countIf(properties.error.:Bool) AS errors ${where}`,
        options,
      )
    ).data[0];
    const groups = (
      await reader.query<{
        label: string | null;
        calls: number;
        priced: number;
        cost_usd: number | null;
      }>(
        `${base} SELECT nullIf(${dimension},'') AS label,count() AS calls,count(usd) AS priced,sumOrNull(usd) AS cost_usd ${where} GROUP BY label ORDER BY cost_usd DESC NULLS LAST,calls DESC,label LIMIT 100`,
        options,
      )
    ).data;
    const rows = (
      await reader.query<{
        id: string;
        time: number;
        provider: string | null;
        model: string | null;
        feature: string | null;
        profile_id: string | null;
        trace_id: string | null;
        cost_usd: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        latency_ms: number | null;
        error: boolean | null;
        cancelled: boolean | null;
      }>(
        `${base} SELECT event_id AS id,toUnixTimestamp64Milli(event_time) AS time,properties.provider.:String AS provider,properties.model.:String AS model,properties.feature.:String AS feature,profile_id,properties.trace_id.:String AS trace_id,usd AS cost_usd,
        ${numeric("properties.input_tokens")} AS input_tokens,${numeric("properties.output_tokens")} AS output_tokens,${numeric("properties.latency_ms")} AS latency_ms,properties.error.:Bool AS error,properties.cancelled.:Bool AS cancelled ${where}
        ORDER BY event_time ${q.trace_id ? "ASC" : "DESC"},event_id ${q.trace_id ? "ASC" : "DESC"} LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
        options,
      )
    ).data;
    return { ...summary, groups, rows, page: q.page, page_size: q.page_size };
  });
}
