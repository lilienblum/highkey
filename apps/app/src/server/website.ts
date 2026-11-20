// A project's website and its cached favicon. Icons are fetched only from public addresses,
// pinned to the address that was checked, with no redirects, cookies or credentials.
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { bad } from "./api/errors";

const MAX_ICON_BYTES = 256 * 1024;

export function normalizeWebsite(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const invalid = () => bad("Use a valid HTTP(S) website address");
  if (value.length > 2048 || value.includes("\\") || /\s/.test(value)) throw invalid();
  const address = value.includes("://") ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    address.includes("@") ||
    url.search ||
    url.hash
  )
    throw bad("Use an HTTP(S) website without credentials, a query, or a fragment");
  return url.origin;
}

function ipv4Number(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 3],
];

function segments(ip: string): number[] {
  const [head = "", tail = ""] = ip.split("::");
  const parse = (part: string) => (part ? part.split(":").map((s) => Number.parseInt(s, 16)) : []);
  const start = parse(head);
  const end = parse(tail);
  const fill = ip.includes("::") ? Array(8 - start.length - end.length).fill(0) : [];
  return [...start, ...fill, ...end];
}

/** Whether an address is globally routable (no private, loopback, special or mapped ranges). */
export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4Number(ip);
    return !PRIVATE_V4.some(([network, bits]) => n >>> (32 - bits) === network >>> (32 - bits));
  }
  if (isIP(ip) !== 6 || ip.includes(".")) return false;
  const s = segments(ip.toLowerCase());
  const [a = 0, b = 0] = s;
  return (
    (a & 0xe000) === 0x2000 &&
    !(a === 0x2001 && (b < 0x0200 || b === 0x0db8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b < 0x1000)
  );
}

export function contentType(bytes: Uint8Array): string | null {
  const starts = (prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0, 0, 1, 0])) return "image/x-icon";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
    return "image/webp";
  return null;
}

function download(
  url: URL,
  address: { address: string; family: number },
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      {
        timeout: 2_000,
        headers: { "user-agent": "Highkey favicon fetcher" },
        // Connect only to the address that passed the public check.
        lookup: ((_host, options, callback) => {
          if (typeof options === "object" && options !== null && options.all)
            (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
              address,
            ]);
          else callback(null, address.address, address.family);
        }) as LookupFunction,
      },
      (response) => {
        const length = Number(response.headers["content-length"] ?? 0);
        if (
          (response.statusCode ?? 0) < 200 ||
          (response.statusCode ?? 0) >= 300 ||
          length > MAX_ICON_BYTES
        ) {
          response.resume();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ICON_BYTES) {
            request.destroy();
            resolve(null);
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          resolve(contentType(bytes) ? bytes : null);
        });
        response.on("error", () => resolve(null));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

async function fetchFrom(website: string): Promise<Uint8Array | null> {
  const url = new URL(website);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!(
    (url.protocol === "https:" && port === "443") ||
    (url.protocol === "http:" && port === "80")
  ))
    return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
  } catch {
    return null;
  }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) return null;
  const address = addresses[0] as { address: string; family: number };
  for (const path of ["/favicon.ico", "/favicon.png", "/apple-touch-icon.png"]) {
    const bytes = await download(new URL(path, url), address);
    if (bytes) return bytes;
  }
  return null;
}

/** The site's favicon, or null after at most four seconds. */
export async function fetchIcon(website: string): Promise<Uint8Array | null> {
  return Promise.race([
    fetchFrom(website).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
  ]);
}
