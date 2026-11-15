// Normalizes an ingestion key's allowed origins, as the Rust API did (apps/ingest checks
// them). Wildcards (`https://*.example.com`) match subdomains only.
import { bad } from "./api/errors";

const INVALID =
  "Use an HTTP(S) origin, such as https://example.com or https://*.example.com, without a path, query, or credentials";

function parse(value: string): { url: URL; wildcard: boolean } {
  const wildcard = value.includes("://*.");
  const plain = value.replace("://*.", "://");
  const afterScheme = plain.split("://")[1];
  const pathStart = afterScheme?.indexOf("/") ?? -1;
  if (
    value.length > 512 ||
    plain.includes("*") ||
    plain.includes("@") ||
    (afterScheme !== undefined && pathStart >= 0 && afterScheme.slice(pathStart + 1) !== "") ||
    plain.includes("\\") ||
    /\s/.test(plain)
  )
    throw bad(INVALID);
  let url: URL;
  try {
    url = new URL(plain);
  } catch {
    throw bad(INVALID);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (wildcard && (!url.hostname.includes(".") || /^[\d.]+$|^\[/.test(url.hostname)))
  )
    throw bad(INVALID);
  return { url, wildcard };
}

export function normalizeOrigins(values: readonly string[]): string[] {
  if (values.length > 16) throw bad("Use at most 16 allowed origins");
  const result: string[] = [];
  for (const value of values) {
    const { url, wildcard } = parse(value.trim());
    const origin = wildcard ? url.origin.replace("://", "://*.") : url.origin;
    if (!result.includes(origin)) result.push(origin);
  }
  return result;
}
