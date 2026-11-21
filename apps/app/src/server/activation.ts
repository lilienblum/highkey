import type { ApiContext } from "./api/context";
import { requireActor } from "./auth/actor";
import { one } from "./db/db";
import { requireSource } from "./db/sources";
import { readAs } from "./queries/read";

export async function activation(ctx: ApiContext, id: string, source: string | null) {
  if (source) await requireSource(ctx.db, id, source);
  const event =
    (
      await readAs(ctx, id, (r) =>
        r.query<{ name: string; source: string; sdk: string }>(
          `SELECT name,source,sdk FROM all_events ${source ? "WHERE source_id={source:UUID}" : ""} ORDER BY received_at,event_id LIMIT 1`,
          { params: { source: source ?? "" } },
        ),
      )
    ).data[0] ?? null;
  const state = await one<{ dashboard: number; mcp: number; invited: number }>(
    ctx.db,
    `SELECT EXISTS(SELECT 1 FROM dashboard_revisions r JOIN dashboards d ON r.dashboard_id=d.id WHERE d.product_id=?1 AND r.origin='mcp') AS dashboard,
      EXISTS(SELECT 1 FROM project_mcp_connections WHERE product_id=?1) AS mcp,
      EXISTS(SELECT 1 FROM invitation WHERE organizationId=?2 AND status IN ('pending','accepted')) AS invited`,
    [id, requireActor(ctx).orgId],
  );
  return {
    first_event: event,
    dashboard: !!state?.dashboard,
    mcp: !!state?.mcp,
    invited: !!state?.invited,
  };
}
