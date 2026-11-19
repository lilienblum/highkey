import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorResponse } from "../src/server/api/errors";
import { type Db, StorageUnavailable } from "../src/server/db/db";
import { createAuth } from "../src/server/auth/auth";
import { openLibsqlDb } from "../src/server/db/libsql-db";
import { TEST_ORIGIN } from "./auth-helpers";
import { call, type TestContext, testContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await testContext();
}, 300_000);
afterAll(() => ctx?.cleanup());

describe("storage errors", () => {
  test("storage_unavailable_answers_503", async () => {
    const response = errorResponse(new StorageUnavailable("binding answered 503"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({
      error: "Management storage is unavailable; retry shortly",
      code: "storage_unavailable",
    });
  });

  test("a_route_answers_503_when_the_database_is_unavailable", async () => {
    const working = ctx.db;
    const unavailable = (): never => {
      throw new StorageUnavailable("binding answered 503");
    };
    ctx.db = {
      execute: async () => unavailable(),
      batch: async () => unavailable(),
      transaction: async () => unavailable(),
      script: async () => unavailable(),
      close: async () => {},
    } satisfies Db;
    try {
      const reply = await call(ctx, "GET", "/api/products");
      expect(reply.status).toBe(503);
      expect(reply.json.code).toBe("storage_unavailable");
      expect(reply.headers.get("Retry-After")).toBe("5");
    } finally {
      ctx.db = working;
    }
  });

  test("an_unreachable_database_answers_503_to_sessions_keys_and_agents", async () => {
    // Signed in and holding a key while the database worked, then the database goes away: for
    // Highkey's tables and for Better Auth's (the same database).
    const key = (await call(ctx, "POST", "/api/keys", { name: "k", access: "read" })).json.key;
    const gone = { url: "http://127.0.0.1:9" };
    const down = {
      ...ctx,
      db: openLibsqlDb(gone),
      auth: async () =>
        createAuth({
          database: { libsql: { ...gone, authToken: "" } },
          publicUrl: TEST_ORIGIN,
          secret: "highkey-test-secret-at-least-32-characters",
          mailer: null,
          signup: "open",
        }),
    } as TestContext;
    const requests: [string, string, Record<string, string>][] = [
      ["session", "/api/products", {}],
      ["key", "/api/products", { cookie: "", authorization: `Bearer ${key}` }],
      ["agent", "/api/mcp", { cookie: "", origin: "", authorization: "Bearer some.oauth.token" }],
    ];
    for (const [who, path, headers] of requests) {
      const reply = await call(
        down,
        path.endsWith("mcp") ? "POST" : "GET",
        path,
        path.endsWith("mcp") ? { jsonrpc: "2.0", id: 1, method: "tools/list" } : undefined,
        headers,
      );
      expect({ who, status: reply.status, code: reply.json?.code }).toEqual({
        who,
        status: 503,
        code: "storage_unavailable",
      });
      expect(reply.headers.get("Retry-After")).toBe("5");
    }
  });
});
