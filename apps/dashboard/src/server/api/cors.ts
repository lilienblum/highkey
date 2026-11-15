// CORS for /api/read: loopback origins, exact configured origins, or any origin when the list
// holds `*`. The `null` origin is never allowed and credentials are never enabled. Other paths
// send no CORS headers at all.

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export function allowedOrigin(origin: string | null, extra: string[]): string | null {
  if (origin === null || origin === "null") return null;
  if (LOOPBACK.test(origin)) return origin;
  if (extra.some((entry) => entry === "*" || entry === origin)) return origin;
  return null;
}

const ALLOW_HEADERS = "content-type,cf-access-client-id,cf-access-client-secret";
const ALLOW_METHODS = "GET,POST,OPTIONS";

export function preflight(request: Request, extra: string[]): Response {
  const origin = allowedOrigin(request.headers.get("origin"), extra);
  const headers: Record<string, string> = {
    vary: "origin, access-control-request-method, access-control-request-headers",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = ALLOW_METHODS;
    headers["access-control-allow-headers"] = ALLOW_HEADERS;
  }
  return new Response(null, { status: 200, headers });
}

export function withReadCors(request: Request, response: Response, extra: string[]): Response {
  const origin = allowedOrigin(request.headers.get("origin"), extra);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "origin");
  return new Response(response.body, { status: response.status, headers });
}
