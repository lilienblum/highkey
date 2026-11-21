import { readBoundedBody } from "./request-body";
import { createHmac } from "node:crypto";
import { tako } from "tako.sh";

// The dashboard serves every /api path itself except ingestion, which belongs to the ingest app.
// Routes that cannot reach the ingest app directly (native development, a single-route tunnel)
// arrive here and are forwarded to HIGHKEY_INGEST_URL, with /tracker.js, which the ingest app serves.

const INGEST_PATHS = ["/api/ingest", "/api/logs/ingest", "/api/logs/v1/logs", "/tracker.js"];

/** Whether a path belongs to the ingest app. */
export function isIngestPath(pathname: string): boolean {
  return INGEST_PATHS.includes(pathname);
}

// Bound buffered uploads before they reach the ingest app's own admission limit.
const maxPendingIngestions = 64;
let pendingIngestions = 0;

/** Forwards an ingestion request (or the tracker) to the ingest app. */
export async function proxyIngest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isUpload = url.pathname !== "/tracker.js" && request.method === "POST";
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Retry-After",
  };
  const unavailable = (message: string) =>
    Response.json({ error: message }, { status: 503, headers: { "Retry-After": "1", ...cors } });
  if (isUpload && pendingIngestions >= maxPendingIngestions)
    return unavailable("Too many pending ingestion requests; retry shortly");
  const upstream = new URL(
    url.pathname + url.search,
    process.env.HIGHKEY_INGEST_URL ?? "http://127.0.0.1:3001",
  );
  // Only what ingestion reads travels on: never cookies, Access identities or client addresses.
  const headers = new Headers();
  if (url.pathname === "/api/ingest") {
    headers.set("x-highkey-forwarded", "1");
    // Only a deployment behind a proxy that replaces X-Forwarded-For may opt into IP forwarding.
    if (process.env.HIGHKEY_TRUST_PROXY_IP === "1") {
      const ip = request.headers.get("x-forwarded-for");
      const secret = tako.secrets.HIGHKEY_CHANGE_TOKEN ?? process.env.HIGHKEY_CHANGE_TOKEN;
      if (secret && ip && /^[a-f0-9.:]{1,45}$/i.test(ip)) {
        headers.set("x-highkey-source-ip", ip);
        headers.set(
          "x-highkey-source-proof",
          createHmac("sha256", secret).update(`highkey-ip:${ip}`).digest("hex"),
        );
      }
    }
    for (const name of ["user-agent", "sec-fetch-mode"]) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v.slice(0, 512));
    }
  }
  for (const name of [
    "accept",
    "content-type",
    "content-encoding",
    "authorization",
    "origin",
    "access-control-request-method",
    "access-control-request-headers",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (isUpload) pendingIngestions++;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(13_000)]);
  try {
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await readBoundedBody(request, 262_144, signal);
    return await fetch(upstream, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set("Access-Control-Allow-Origin", "*");
      return error;
    }
    return unavailable("Ingestion is unavailable; retry shortly");
  } finally {
    if (isUpload) pendingIngestions--;
  }
}
