import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { errorResponse } from "../src/server/api/errors";
import { type Db, StorageUnavailable } from "../src/server/db/db";
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
});
