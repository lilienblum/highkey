// The account screens talk to Better Auth's endpoints under /api/auth directly. When an agent's
// authorization brought the person here, the page's signed OAuth query rides along on every
// request, so signing in, choosing an organization and consenting continue that authorization.

export interface AuthResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** A sentence to show the person, from the server when it gave one. */
  error: string | null;
}

/** The signed part of an authorization's query (its signature names the parameters it covers). */
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) return undefined;
  const covered = new Set(params.getAll("ba_param"));
  const signed = new URLSearchParams();
  for (const [key, value] of params)
    if (key === "sig" || key === "ba_param" || covered.has(key)) signed.append(key, value);
  return signed.toString();
}

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don’t match an account.",
  EMAIL_NOT_VERIFIED: "Verify your email first; we sent you a link.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with this email already exists. Sign in instead.",
  PASSWORD_TOO_SHORT: "Use a password of at least 10 characters.",
  INVALID_TOKEN: "This link has expired or was already used.",
  INVALID_CODE: "That code isn’t right. Check your authenticator and try again.",
  BANNED_USER: "This account is banned. Contact the server admin.",
};

function messageOf(body: unknown, status: number): string {
  const { code, message } = (body ?? {}) as { code?: string; message?: string };
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (message) return message;
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  return "Something went wrong. Try again.";
}

/** POSTs to a Better Auth endpoint, adding the page's OAuth query when there is one. */
export async function authPost<T = unknown>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<AuthResult<T>> {
  const oauth =
    typeof window === "undefined" ? undefined : signedOAuthQuery(window.location.search);
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(
        oauth && !("oauth_query" in body) ? { ...body, oauth_query: oauth } : body,
      ),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: "Highkey can’t be reached. Check your connection.",
    };
  }
  const data = (await response.json().catch(() => null)) as T | null;
  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? data : null,
    error: response.ok ? null : messageOf(data, response.status),
  };
}

/** Where to go after signing in: a same-site path from `?redirect=`, else the Overview. */
export function afterSignIn(search: string): string {
  const target = new URLSearchParams(search).get("redirect");
  return target?.startsWith("/") && !target.startsWith("//") ? target : "/";
}

/**
 * Follows a Better Auth answer: an authorization it continued (`{ redirect, url }`) or the next
 * page. A full navigation, so the workspace loads fresh for the signed-in person.
 */
export function follow(data: unknown, fallback: string): void {
  const { url } = (data ?? {}) as { url?: unknown };
  window.location.assign(typeof url === "string" && url ? url : fallback);
}

/** GETs a Better Auth endpoint; throws the sentence to show when it fails. */
export async function authGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(messageOf(data, response.status));
  return data as T;
}

/** POSTs to a Better Auth endpoint; throws the sentence to show when it fails. */
export async function authAction<T = unknown>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const result = await authPost<T>(path, body);
  if (!result.ok) throw new Error(result.error ?? "Something went wrong. Try again.");
  return result.data as T;
}
