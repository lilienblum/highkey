// The tools on both MCP paths: they read projects, run widgets and check documents, and never
// change anything. Each calls the function its HTTP route calls.
import { requireActor } from "../auth/actor";
import type { ApiContext } from "../api/context";
import { catalog } from "../dashboards/catalog";
import { validateFor } from "../dashboards/routes";
import { runWidget } from "../dashboards/run";
import { getDashboard, listDashboards, listRevisions } from "../dashboards/storage";
import { logRetention } from "../db/keys";
import { products } from "../db/products";
import { listSources } from "../db/sources";
import { getView, listViews } from "../views";
import { parseEntityQuery, runEntityQuery } from "../queries/entities";
import { readAs } from "../queries/read";
import { revenueReport } from "../queries/revenue";
import { personDetail, peopleList } from "../queries/people";
import { sessionList, sessionDetail } from "../queries/sessions";
import { type Args, badArgument, projectId, type Tool } from "./common";

/** Points kept per series by run_widget; a long series is trimmed to its newest points. */
const MAX_POINTS = 200;
/** Rows kept by run_widget; a longer table is trimmed to its first rows. */
const MAX_ROWS = 50;
/** Rows a sample tool returns at most. */
const MAX_SAMPLE_ROWS = 20;
/** How far back run_widget and the sample tools look when no range is given. */
const DEFAULT_DAYS = 7;

/** An RFC 3339 time, or a date meaning midnight UTC. `field` is the argument's JSON Pointer. */
function time(field: string, text: string): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00Z`)
    : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)
      ? new Date(text)
      : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()))
    throw badArgument(
      field,
      `\`${text}\` is not a time`,
      "Use an RFC 3339 time such as 2026-11-01T00:00:00Z, or a date such as 2026-11-01",
    );
  return date;
}

/** The range to run over: `from` and `to`, else the last seven days up to now. */
function range(from?: string | null, to?: string | null): { from: string; to: string } {
  const end = to != null ? time("/to", to) : new Date();
  const start =
    from != null ? time("/from", from) : new Date(end.getTime() - DEFAULT_DAYS * 86_400_000);
  return { from: start.toISOString(), to: end.toISOString() };
}

type Run = Awaited<ReturnType<typeof runWidget>>;

/** Keeps the newest points of every series and the first rows, and says so in the warnings. */
function trim(run: Run): Run {
  const warnings = [...run.warnings];
  let rows = run.rows;
  if (rows && rows.length > MAX_ROWS) {
    warnings.push({
      path: "/rows",
      message: `Showing the first ${MAX_ROWS} of ${rows.length} rows`,
      hint: "Narrow from and to, or use a longer period, to see the rest; a saved widget shows every row",
    });
    rows = rows.slice(0, MAX_ROWS);
  }
  const series = run.series.map((s, i) => {
    let longest = 0;
    const out = { ...s };
    for (const key of ["points", "previous_points"] as const) {
      const points = s[key];
      if (points && points.length > MAX_POINTS) {
        longest = Math.max(longest, points.length);
        out[key] = points.slice(points.length - MAX_POINTS);
      }
    }
    if (longest > 0)
      warnings.push({
        path: `/series/${i}/points`,
        message: `Showing the newest ${MAX_POINTS} of ${longest} points`,
        hint: "Narrow from and to, or use a coarser bucket, to see the rest",
      });
    return out;
  });
  return { ...run, series, rows, warnings };
}

/** The newest rows of one events or logs list over the default range, at most `limit`. */
async function sample(ctx: ApiContext, project: string, query: Args, limit?: number | null) {
  const id = await projectId(ctx, project);
  const view = query.signal === "logs" ? "logs" : "events";
  const run = await runWidget(ctx, id, {
    widget: { id: "sample", title: "Sample", view: { type: view }, queries: { rows: query } },
    ...range(),
  });
  const keep = Math.min(Math.max(limit ?? MAX_SAMPLE_ROWS, 1), MAX_SAMPLE_ROWS);
  return { rows: (run.rows ?? []).slice(0, keep), range: run.range, warnings: run.warnings };
}

const defined = (entries: [string, unknown][]) =>
  Object.fromEntries(entries.filter(([, value]) => value != null));

const report =
  (run: (ctx: ApiContext, id: string, body: unknown) => Promise<unknown>): Tool =>
  async (ctx, a) => {
    const { project, from, to, ...query } = a;
    return run(ctx, await projectId(ctx, project), { ...query, ...range(from, to) });
  };

export const readTools: Record<string, Tool> = {
  list_people: report(peopleList),
  get_profile: report(personDetail),
  query_sessions: report(sessionList),
  get_session: report(sessionDetail),
  query_revenue: report(revenueReport),
  query_profiles: async (ctx, a) => {
    const { project, ...query } = a;
    const id = await projectId(ctx, project);
    return readAs(ctx, id, (reader) => runEntityQuery(reader, "profiles", parseEntityQuery(query)));
  },
  query_groups: async (ctx, a) => {
    const { project, ...query } = a;
    const id = await projectId(ctx, project);
    return readAs(ctx, id, (reader) => runEntityQuery(reader, "groups", parseEntityQuery(query)));
  },
  list_projects: async (ctx) =>
    (await products(ctx.db, requireActor(ctx).orgId)).map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      retention_days: p.retention_days,
    })),
  describe_project: async (ctx, a) => catalog(ctx, await projectId(ctx, a.project)),
  run_widget: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const window = range(a.from, a.to);
    return trim(await runWidget(ctx, id, { widget: a.widget, ...window, source_id: a.source_id }));
  },
  sample_events: async (ctx, a) =>
    sample(ctx, a.project, { signal: "events", ...defined([["event", a.event]]) }, a.limit),
  sample_logs: async (ctx, a) =>
    sample(
      ctx,
      a.project,
      {
        signal: "logs",
        ...defined([
          ["level", a.level],
          ["service", a.service],
          ["search", a.search],
        ]),
      },
      a.limit,
    ),
  list_dashboards: async (ctx, a) => listDashboards(ctx.db, await projectId(ctx, a.project)),
  get_dashboard: async (ctx, a) =>
    getDashboard(ctx.db, await projectId(ctx, a.project), a.dashboard),
  list_revisions: async (ctx, a) =>
    listRevisions(ctx.db, await projectId(ctx, a.project), a.dashboard),
  validate_dashboard: async (ctx, a) =>
    validateFor(ctx, await projectId(ctx, a.project), a.document),
  list_views: async (ctx, a) => listViews(ctx.db, await projectId(ctx, a.project), a.kind ?? null),
  get_view: async (ctx, a) =>
    getView(ctx.db, await projectId(ctx, a.project), a.view, a.kind ?? null),
  list_sources: async (ctx, a) => listSources(ctx.db, await projectId(ctx, a.project)),
  get_log_settings: async (ctx, a) => ({
    retention_days: await logRetention(ctx.db, await projectId(ctx, a.project)),
  }),
};
