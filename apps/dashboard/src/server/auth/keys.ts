// API keys: `hk_…`, sent as `Authorization: Bearer hk_…` or `X-Api-Key`. Each belongs to the
// person who made it and to one organization (its metadata), and is capped on every use by the
// role that person holds there now.

export const KEY_PREFIX = "hk_";

/** The API key a request carries, if any. Other bearer tokens (agents' OAuth tokens) are not keys. */
export function keyFrom(headers: Headers): string | null {
  const header = headers.get("x-api-key")?.trim();
  if (header) return header;
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  return bearer?.startsWith(KEY_PREFIX) ? bearer : null;
}

/** What a key's metadata holds. */
export interface KeyMetadata {
  orgId: string;
  access: "read" | "write";
}

export function keyMetadata(value: unknown): KeyMetadata | null {
  const meta = (
    typeof value === "string" ? safeParse(value) : value
  ) as Partial<KeyMetadata> | null;
  if (!meta || typeof meta.orgId !== "string") return null;
  return { orgId: meta.orgId, access: meta.access === "write" ? "write" : "read" };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
