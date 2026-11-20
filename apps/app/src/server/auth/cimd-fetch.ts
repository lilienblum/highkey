// Fetches an agent's Client ID Metadata Document (its OAuth client_id is an HTTPS URL). The URL
// comes from whoever starts an authorization, so the fetch guards against reaching inside the
// network: HTTPS on port 443 only, the host resolved once and every address public, the
// connection pinned to the address that was checked, no redirects, 64 KiB and 5 seconds at most.
import { lookup } from "node:dns/promises";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { publicAddress } from "../website";

export const MAX_METADATA_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

type Address = { address: string; family: number };
type Resolve = (host: string) => Promise<Address[]>;

const resolveAll: Resolve = (host) => lookup(host, { all: true });

/** The one public address to connect to for `url`, or an error saying why there is none. */
export async function pinnedAddress(url: URL, resolve: Resolve = resolveAll): Promise<Address> {
  if (url.protocol !== "https:") throw new TypeError("Client metadata must be served over HTTPS");
  if (url.port && url.port !== "443")
    throw new TypeError("Client metadata must be served on the default HTTPS port");
  if (url.username || url.password)
    throw new TypeError("Client metadata URLs carry no credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new TypeError("Client metadata hosts must resolve only to public addresses");
  return addresses[0] as Address;
}

/** A metadata response as the plugin may read it: no redirect, and a bounded body. */
export async function capped(response: Response): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new TypeError("Client metadata documents may not redirect");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = reader ? await reader.read() : { done: true as const, value: undefined };
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_METADATA_BYTES) {
      await reader?.cancel();
      throw new TypeError("Client metadata documents are at most 64 KiB");
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(response.status === 204 ? null : body, {
    status: response.status,
    headers: response.headers,
  });
}

function get(url: URL, address: Address, headers: Headers, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: false,
        signal,
        headers: { ...Object.fromEntries(headers), host: url.host },
        // Connect only to the address that passed the public check.
        lookup: ((_host, options, callback) => {
          if (typeof options === "object" && options !== null && options.all)
            (callback as (e: null, a: Address[]) => void)(null, [address]);
          else callback(null, address.address, address.family);
        }) as LookupFunction,
      },
      (response) => {
        const out = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
            out.append(name, item);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            response.on("end", () => controller.close());
            response.on("error", (error) => controller.error(error));
          },
          cancel() {
            response.destroy();
          },
        });
        resolve(new Response(body, { status: response.statusCode ?? 502, headers: out }));
      },
    );
    request.on("error", reject);
  });
}

/** The CIMD plugin's transport. */
export async function cimdFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (request.method !== "GET") throw new TypeError("Client metadata is fetched with GET only");
  const url = new URL(request.url);
  const address = await pinnedAddress(url);
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), request.signal]);
  return capped(await get(url, address, request.headers, signal));
}
