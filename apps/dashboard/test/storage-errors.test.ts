import { describe, expect, test } from "bun:test";
import { errorResponse } from "../src/server/api/errors";
import { StorageUnavailable } from "../src/server/db/db";

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
});
