// Live hints: the ingest app's post-commit notifications and the dashboard's own writes, published
// to the live stream of the organization that owns each project. A hint names projects and
// signals only, never data or credentials.
import { timingSafeEqual } from "node:crypto";
import { tako } from "tako.sh";
import changes from "../channels/analytics-changes";
import { type ChangeEnvelope, parseChangeEnvelope } from "../lib/change-envelope";
import { apiContext } from "./api/context";
import { all, type Db } from "./db/db";
import { readBoundedBody } from "./request-body";

export { sessionCookieName } from "./auth/cookie";
export { verifyChannel } from "./live-auth";

type Publish = (org: string, envelope: ChangeEnvelope) => Promise<void>;

const takoPublish: Publish = async (org, envelope) => {
  await changes({ org }).publish({ type: "changed", data: envelope });
};

/**
 * Splits a hint by the organizations that own its projects and publishes each part to that
 * organization's stream. Projects no organization owns are dropped; a full resync (`changes:
 * null`) goes to every organization with projects.
 */
export async function routeChanges(db: Db, envelope: ChangeEnvelope, publish: Publish) {
  if (envelope.changes === null) {
    const orgs = await all<{ org_id: string }>(
      db,
      "SELECT DISTINCT org_id FROM products WHERE org_id IS NOT NULL",
    );
    await Promise.all(orgs.map(({ org_id }) => publish(org_id, envelope)));
    return;
  }
  const ids = envelope.changes.map((change) => change.product);
  const owners = new Map(
    (
      await all<{ id: string; org_id: string | null }>(
        db,
        `SELECT id, org_id FROM products WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      )
    ).map((row) => [row.id, row.org_id]),
  );
  const byOrg = new Map<string, NonNullable<ChangeEnvelope["changes"]>>();
  for (const change of envelope.changes) {
    const org = owners.get(change.product);
    if (org) byOrg.set(org, [...(byOrg.get(org) ?? []), change]);
  }
  await Promise.all([...byOrg].map(([org, part]) => publish(org, { version: 2, changes: part })));
}

export function realtimeEnabled(): boolean {
  return Boolean(process.env.TAKO_APP_NAME && tako.secrets.HIGHKEY_CHANGE_TOKEN);
}

export async function receiveChanges(request: Request): Promise<Response> {
  const token = tako.secrets.HIGHKEY_CHANGE_TOKEN;
  if (!realtimeEnabled() || !token)
    return Response.json({ error: "Live updates are not configured" }, { status: 503 });
  const supplied = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
    return Response.json({ error: "Invalid change notification credential" }, { status: 401 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 8_192)));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "Expected a JSON change notification" }, { status: 400 });
  }
  const envelope = parseChangeEnvelope(value);
  if (!envelope)
    return Response.json(
      { error: "Expected a version 1 or 2 change notification for null or 1–64 product UUIDs" },
      { status: 400 },
    );
  try {
    await routeChanges(apiContext().db, envelope, takoPublish);
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "Live updates temporarily unavailable" }, { status: 503 });
  }
}

/** Publishes a change made in this process (a dashboard, view or workspace write). */
export function publishChange(product: string, signal: "events" | "logs" | "dashboards"): void {
  if (!realtimeEnabled()) return;
  routeChanges(
    apiContext().db,
    { version: 2, changes: [{ product, signals: [signal] }] },
    takoPublish,
  ).catch(() => {
    // Live updates are a hint; an open dashboard also refreshes on its own schedule.
  });
}
