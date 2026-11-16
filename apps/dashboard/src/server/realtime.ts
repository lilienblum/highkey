import { timingSafeEqual } from "node:crypto";
import { tako } from "tako.sh";
import changes from "../channels/analytics-changes";
import { parseChangeEnvelope } from "../lib/change-envelope";
import { readBoundedBody } from "./request-body";

export function realtimeEnabled(): boolean {
  return Boolean(process.env.TAKO_APP_NAME && tako.secrets.PIKO_CHANGE_TOKEN);
}

export async function receiveChanges(request: Request): Promise<Response> {
  const token = tako.secrets.PIKO_CHANGE_TOKEN;
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
    await changes.publish({ type: "changed", data: envelope });
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "Live updates temporarily unavailable" }, { status: 503 });
  }
}

/** Publishes a change made in this process (a dashboard, view or workspace write). */
export function publishChange(product: string, signal: "events" | "logs" | "dashboards"): void {
  if (!realtimeEnabled()) return;
  changes
    .publish({ type: "changed", data: { version: 2, changes: [{ product, signals: [signal] }] } })
    .catch(() => {
      // Live updates are a hint; an open dashboard also refreshes on its own schedule.
    });
}
