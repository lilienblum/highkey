import { expect, test } from "bun:test";

const { isIngestPath, proxyIngest } = await import("../apps/app/src/server/api-gateway");

// The test process owns its environment; the generated app bindings are read-only.
async function withIngestUrl(url: string, run: () => Promise<void>) {
  const env: Record<string, string | undefined> = process.env;
  const previous = env.HIGHKEY_INGEST_URL;
  env.HIGHKEY_INGEST_URL = url;
  try {
    await run();
  } finally {
    if (previous === undefined) delete env.HIGHKEY_INGEST_URL;
    else env.HIGHKEY_INGEST_URL = previous;
  }
}

async function withUpstream(
  respond: (request: Request) => Response | Promise<Response>,
  run: (
    received: { url: string; method: string; headers: Headers; body: string }[],
  ) => Promise<void>,
) {
  const received: { url: string; method: string; headers: Headers; body: string }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      return respond(request);
    },
  });
  try {
    await withIngestUrl(upstream.url.toString(), () => run(received));
  } finally {
    upstream.stop(true);
  }
}

test("only the ingestion paths and the tracker are forwarded", () => {
  for (const path of ["/api/ingest", "/api/logs/ingest", "/api/logs/v1/logs", "/tracker.js"])
    expect(isIngestPath(path)).toBe(true);
  for (const path of ["/api/products", "/api/mcp", "/api/read/products", "/api/ingest/x", "/"])
    expect(isIngestPath(path)).toBe(false);
});

test("gateway forwards ingestion with its key and strips browser identity and cookies", async () => {
  await withUpstream(
    () => Response.json({ accepted: 1, duplicates: 0 }),
    async (received) => {
      const body = JSON.stringify({ event_id: "example", name: "build", source: "cli" });
      const response = await proxyIngest(
        new Request("https://dashboard.example/api/ingest?example=1", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: "Bearer public-ingestion-key",
            "x-highkey-admin": "1",
            origin: "https://site.example",
            cookie: "session=browser-session",
            referer: "https://site.example/account?token=private",
            "user-agent": "Private browser fingerprint",
            "x-forwarded-for": "192.0.2.1",
            "cf-connecting-ip": "192.0.2.1",
            "cf-access-authenticated-user-email": "private@example.com",
            "cf-access-jwt-assertion": "browser-jwt",
            "cf-access-client-id": "untrusted-id",
            "cf-access-client-secret": "untrusted-secret",
            "x-custom-identity": "private",
          },
          body,
        }),
      );
      expect(response.ok).toBe(true);
      expect(received).toHaveLength(1);
      const request = received[0];
      expect(new URL(request.url).pathname + new URL(request.url).search).toBe(
        "/api/ingest?example=1",
      );
      expect(request.method).toBe("POST");
      expect(request.body).toBe(body);
      expect(request.headers.get("authorization")).toBe("Bearer public-ingestion-key");
      expect(request.headers.get("origin")).toBe("https://site.example");
      for (const name of [
        "cookie",
        "referer",
        "x-highkey-admin",
        "x-forwarded-for",
        "cf-connecting-ip",
        "cf-access-authenticated-user-email",
        "cf-access-jwt-assertion",
        "cf-access-client-id",
        "cf-access-client-secret",
        "x-custom-identity",
      ])
        expect(request.headers.has(name)).toBe(false);
      expect(request.headers.get("user-agent")).not.toBe("Private browser fingerprint");
      await proxyIngest(
        new Request("https://dashboard.example/api/ingest", {
          method: "OPTIONS",
          headers: {
            origin: "https://site.example",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type",
          },
        }),
      );
      expect(received[1].method).toBe("OPTIONS");
      expect(received[1].headers.get("access-control-request-method")).toBe("POST");
      expect(received[1].headers.get("access-control-request-headers")).toBe(
        "authorization, content-type",
      );
    },
  );
});

test("gateway forwards the tracker from the ingest app", async () => {
  await withUpstream(
    () =>
      new Response("export {}", {
        headers: {
          "content-type": "application/javascript",
          "cache-control": "public, max-age=3600",
        },
      }),
    async (received) => {
      const response = await proxyIngest(new Request("https://dashboard.example/tracker.js"));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("export {}");
      expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(new URL(received[0].url).pathname).toBe("/tracker.js");
    },
  );
});

test("an unreachable ingest app is a retryable 503 with ingest CORS", async () => {
  await withIngestUrl("http://127.0.0.1:9", async () => {
    const response = await proxyIngest(
      new Request("https://dashboard.example/api/ingest", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

test("gateway bounds pending uploads, cancels them, and releases admission slots", async () => {
  const controllers = Array.from({ length: 64 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    proxyIngest(
      new Request("https://dashboard.example/api/ingest", {
        method: "POST",
        signal: controller.signal,
        body: new ReadableStream(),
      }),
    ),
  );
  try {
    const overloaded = await proxyIngest(
      new Request("https://dashboard.example/api/ingest", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get("retry-after")).toBe("1");
    expect(overloaded.headers.get("access-control-expose-headers")).toBe("Retry-After");
    expect(overloaded.headers.get("access-control-allow-origin")).toBe("*");
  } finally {
    for (const controller of controllers) controller.abort();
    expect((await Promise.all(pending)).every((response) => response.status === 503)).toBe(true);
  }
  // Reaching body validation proves the slots were released. No upstream request is needed.
  const oversized = await proxyIngest(
    new Request("https://dashboard.example/api/ingest", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "262145" },
    }),
  );
  expect(oversized.status).toBe(413);
  expect(oversized.headers.get("access-control-allow-origin")).toBe("*");
});
