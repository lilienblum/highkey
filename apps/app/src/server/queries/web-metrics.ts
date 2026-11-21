import type { ApiContext } from "../api/context";
import { fields } from "../api/body";
import { requireSource } from "../db/sources";
import { runSettings } from "../clickhouse/access";
import { parseEventsQuery, predicate } from "./events";
import { customRules } from "./custom";
import { bucketGrid, Params } from "./properties";
import { readAs } from "./read";

const zero = {
  visitors: 0,
  sessions: 0,
  page_views: 0,
  pages_per_session: null as number | null,
  bounce_rate: null as number | null,
  session_duration: null as number | null,
  revenue: "0",
};
type Metrics = typeof zero;
export async function webMetrics(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      from: "string",
      to: "string",
      bucket: "string",
      source_id: "string?",
      event: "string?",
      source: "string?",
      filters: "unknown",
    },
    { bucket: "day" },
  );
  const spec = parseEventsQuery(q),
    params = new Params(),
    where = predicate(
      spec,
      params,
      spec.event?.startsWith("@") ? await customRules(ctx.db, id) : undefined,
    );
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  const match =
    where === "1"
      ? ""
      : `WHERE (source_id,actor_id,session_id) IN (SELECT source_id,actor_id,session_id FROM events WHERE identity_kind='visitor' AND session_id IS NOT NULL AND ${where})`;
  return readAs(ctx, id, async (r) => {
    async function window(from: Date, to: Date, withBuckets: boolean) {
      const opts = {
        settings: runSettings({ from, to, bucket: spec.bucket, source: q.source_id ?? null }),
        params: params.values,
      };
      const by = (time: string) =>
        withBuckets
          ? `toUnixTimestamp64Milli(bucket(${time})) AS bin,grouping(bin) AS total`
          : "0 AS bin,1 AS total";
      const group = withBuckets ? " GROUP BY GROUPING SETS ((bin),())" : "";
      const events = await r.query<
        { bin: number; total: number } & Pick<Metrics, "visitors" | "page_views" | "revenue">
      >(
        `SELECT ${by("event_time")},uniqExactIf(actor_id,identity_kind='visitor') AS visitors,countIf(name='page_view') AS page_views,toString(sumIf(cents,abs(cents)<=9007199254740991)) AS revenue FROM (SELECT *,coalesce(toInt128(properties.revenue.:Int64),toInt128(properties.revenue.:UInt64),0) AS cents FROM events WHERE ${where})${group}`,
        opts,
      );
      const sessions = await r.query<
        { bin: number; total: number } & Pick<
          Metrics,
          "sessions" | "pages_per_session" | "bounce_rate" | "session_duration"
        >
      >(
        `SELECT ${by("started_at")},count() AS sessions,avgOrNull(page_views) AS pages_per_session,avgOrNull(bounced)*100 AS bounce_rate,avgOrNull(duration_ms)/1000 AS session_duration FROM sessions ${match}${group}`,
        opts,
      );
      const summary = { ...zero },
        bins = new Map<number, Metrics>();
      for (const { bin, total, ...metrics } of [...events.data, ...sessions.data]) {
        if (total) Object.assign(summary, metrics);
        else bins.set(bin, { ...zero, ...bins.get(bin), ...metrics });
      }
      return { summary, bins };
    }
    const current = await window(spec.from, spec.to, true),
      prior = await window(new Date(+spec.from - (+spec.to - +spec.from)), spec.from, false);
    return {
      current: current.summary,
      previous: prior.summary,
      series: bucketGrid(spec.from, spec.to, spec.bucket).map((time) => ({
        time,
        ...(current.bins.get(time) ?? zero),
      })),
    };
  });
}
