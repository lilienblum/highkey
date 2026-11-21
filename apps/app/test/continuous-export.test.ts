import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { configuredExport, exportBatch } from "../src/server/export";
import { call, project, seedEvents, seedLogs, testContext } from "./helpers";
test("the configured S3-compatible transport signs and PUTs the exact gzip object", async () => {
  let request: { path: string; authorization: string | null; content: Buffer } | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(r) {
      request = {
        path: new URL(r.url).pathname,
        authorization: r.headers.get("authorization"),
        content: Buffer.from(await r.arrayBuffer()),
      };
      return new Response(null, { headers: { etag: '"test"' } });
    },
  });
  const env = {
    HIGHKEY_EXPORT_BUCKET: "test-bucket",
    HIGHKEY_EXPORT_ENDPOINT: server.url.origin,
    HIGHKEY_EXPORT_ACCESS_KEY_ID: "example",
    HIGHKEY_EXPORT_SECRET_ACCESS_KEY: "unit-test-secret",
    HIGHKEY_EXPORT_REGION: "us-east-1",
  };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, env);
    await configuredExport()!("highkey/unit/events/part.jsonl.gz", new Uint8Array([31, 139, 8]));
    expect(request?.authorization).toStartWith("AWS4-HMAC-SHA256 ");
    expect(request?.path).toBe("/test-bucket/highkey/unit/events/part.jsonl.gz");
    expect([...request!.content]).toEqual([31, 139, 8]);
  } finally {
    await server.stop(true);
    for (const [key, v] of Object.entries(previous))
      if (v == null) delete process.env[key];
      else process.env[key] = v;
  }
});
test("uncertain object writes retry the identical pending bytes; streams have isolated cursors", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      other = await project(ctx, "Elsewhere");
    await seedEvents(p.id, [
      { event_id: "x", properties: { mixed: false } },
      { event_id: "z", properties: { mixed: 5 } },
    ]);
    await seedEvents(other.id, [{ event_id: "other" }]);
    await seedLogs(p.id, [{ log_id: "l" }]);
    ctx.now = () => new Date(Date.now() + 120000);
    for (const signal of ["events", "logs"])
      await ctx.db.execute(
        "INSERT INTO export_streams(product_id,signal,enabled,cursor_ms) VALUES(?,?,1,0)",
        [p.id, signal],
      );
    const writes: { key: string; data: Uint8Array }[] = [];
    const upload = async (key: string, data: Uint8Array) => {
      writes.push({ key, data });
      if (writes.length === 1) throw Error("timeout after PUT");
    };
    await expect(exportBatch(ctx, p.id, "events", upload)).rejects.toThrow("timeout");
    const cursor = await ctx.db.execute(
      "SELECT cursor_ms,pending_key FROM export_streams WHERE product_id=? AND signal='events'",
      [p.id],
    );
    expect(cursor.rows[0]).toMatchObject({ cursor_ms: 0, pending_key: writes[0].key });
    expect(await exportBatch(ctx, p.id, "events", upload)).toBe(true);
    expect(writes[1].key).toBe(writes[0].key);
    expect(Buffer.compare(Buffer.from(writes[0].data), Buffer.from(writes[1].data))).toBe(0);
    const rows = gunzipSync(writes[1].data)
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.map((v) => [v.event_id, v.properties.mixed])).toEqual([
      ["x", false],
      ["z", 5],
    ]);
    expect(rows[0]).not.toHaveProperty("ai_prompt");
    expect(await exportBatch(ctx, p.id, "events", upload)).toBe(false);
    expect(await exportBatch(ctx, p.id, "logs", upload)).toBe(true);
    expect(JSON.parse(gunzipSync(writes[2].data).toString()).log_id).toBe("l");
    expect(
      (await call(ctx, "PUT", `/api/products/${p.id}/export`, { signal: "events", enabled: false }))
        .status,
    ).toBe(200);
  } finally {
    ctx.cleanup();
  }
});
