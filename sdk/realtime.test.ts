import { describe, expect, test } from "bun:test";
import {
  matches,
  parseChangeEnvelope,
  type ChangeEnvelope,
} from "../apps/dashboard/src/lib/change-envelope";
import { readBoundedBody } from "../apps/dashboard/src/server/request-body";

describe("change notification validation", () => {
  test("parses v1 as events", () => {
    const id = crypto.randomUUID();
    expect(parseChangeEnvelope({ version: 1, products: null })).toEqual({
      version: 2,
      changes: null,
    });
    expect(parseChangeEnvelope({ version: 1, products: [id, id.toUpperCase()] })).toEqual({
      version: 2,
      changes: [{ product: id, signals: ["events"] }],
    });
    for (const value of [
      { version: 1, products: [] },
      { version: 1, products: ["not-an-id"] },
      { version: 1, products: Array.from({ length: 65 }, () => crypto.randomUUID()) },
    ])
      expect(parseChangeEnvelope(value)).toBeNull();
  });
  test("parses v2 and rejects unknown signals", () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    expect(parseChangeEnvelope({ version: 2, changes: null })).toEqual({
      version: 2,
      changes: null,
    });
    expect(
      parseChangeEnvelope({
        version: 2,
        changes: [
          { product: a, signals: ["events", "logs", "events"] },
          { product: b, signals: ["dashboards"] },
        ],
      }),
    ).toEqual({
      version: 2,
      changes: [
        { product: a, signals: ["events", "logs"] },
        { product: b, signals: ["dashboards"] },
      ],
    });
    for (const value of [
      null,
      {},
      { version: 3, changes: null },
      { version: 2 },
      { version: 2, changes: [] },
      { version: 2, changes: [{ product: a, signals: [] }] },
      { version: 2, changes: [{ product: a, signals: ["metrics"] }] },
      { version: 2, changes: [{ product: "nope", signals: ["events"] }] },
      { version: 2, changes: [{ product: a, signals: ["events"], extra: 1 }] },
      { version: 2, changes: null, products: null },
      {
        version: 2,
        changes: Array.from({ length: 65 }, () => ({
          product: crypto.randomUUID(),
          signals: ["events"],
        })),
      },
    ])
      expect(parseChangeEnvelope(value)).toBeNull();
  });
  test("matches filters by product and signal", () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    const envelope: ChangeEnvelope = {
      version: 2,
      changes: [
        { product: a, signals: ["events", "logs"] },
        { product: b, signals: ["dashboards"] },
      ],
    };
    expect(matches(envelope, a, ["events"])).toBe(true);
    expect(matches(envelope, a, ["logs", "dashboards"])).toBe(true);
    expect(matches(envelope, a, ["dashboards"])).toBe(false);
    expect(matches(envelope, b, ["dashboards"])).toBe(true);
    expect(matches(envelope, b, ["events"])).toBe(false);
    expect(matches(envelope, crypto.randomUUID(), ["events"])).toBe(false);
    expect(matches({ version: 2, changes: null }, a, ["logs"])).toBe(true);
  });
  test("log-only changes do not match an events-only subscriber", () => {
    const id = crypto.randomUUID();
    const envelope: ChangeEnvelope = {
      version: 2,
      changes: [{ product: id, signals: ["logs"] }],
    };
    expect(matches(envelope, id, ["events"])).toBe(false);
  });
  test("streamed payloads are bounded even without Content-Length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    try {
      await readBoundedBody(new Request("http://localhost/changes", { method: "POST", body }), 8);
      throw new Error("Expected oversized body to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(413);
    }
  });
});

test("body deadline cancels a stalled upload without awaiting its cleanup", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  await expect(
    readBoundedBody(
      new Request("http://localhost/changes", { method: "POST", body }),
      8,
      AbortSignal.timeout(20),
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("oversized body rejection does not wait for stream cancellation", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  const result = readBoundedBody(
    new Request("http://localhost/changes", { method: "POST", body }),
    8,
  );
  await expect(result).rejects.toMatchObject({ status: 413 });
});
