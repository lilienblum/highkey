import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readerUser } from "../src/server/clickhouse/access";
import { ClickHouse } from "../src/server/clickhouse/client";
import { readAs } from "../src/server/queries/read";
import { reconcile } from "../src/server/registry";
import { call, project, seedEvents, type TestContext, testAdmin, testContext } from "./helpers";

let ctx: TestContext;
let admin: ClickHouse;

beforeAll(async () => {
  ctx = await testContext();
  admin = await testAdmin();
}, 300_000);

afterAll(() => ctx?.cleanup());

async function registry(productId: string) {
  return (
    await admin.query<{
      kind: string;
      revoked: number;
      retention_days: number;
      allowed_origins: string[];
      source_id: string;
    }>(
      "SELECT kind, revoked, retention_days, allowed_origins, toString(source_id) AS source_id FROM piko.ingest_keys WHERE product_id = {p:UUID} ORDER BY kind, updated_at",
      { params: { p: productId } },
    )
  ).data;
}

async function expiry(productId: string) {
  return (
    await admin.query<{ event_id: string; days: number }>(
      "SELECT event_id, dateDiff('day', toDateTime(event_time), expires_at) AS days FROM piko.events FINAL WHERE product_id = {p:UUID} ORDER BY event_id",
      { params: { p: productId } },
    )
  ).data;
}

describe("registry and access", () => {
  test("creating_a_key_mirrors_it_and_revoking_marks_it_revoked", async () => {
    const { id } = await project(ctx, "Mirrored", 30);
    const key = await call(ctx, "POST", `/api/products/${id}/keys`, {
      label: "web",
      allowed_origins: ["https://example.com"],
    });
    await call(ctx, "PATCH", `/api/products/${id}/logs/settings`, { retention_days: 3 });
    const logKey = await call(ctx, "POST", `/api/products/${id}/logs/keys`, { label: "logs" });
    expect(await registry(id)).toEqual([
      {
        kind: "events",
        revoked: 0,
        retention_days: 30,
        allowed_origins: ["https://example.com"],
        source_id: id,
      },
      { kind: "logs", revoked: 0, retention_days: 3, allowed_origins: [], source_id: id },
    ]);
    await call(ctx, "DELETE", `/api/products/${id}/keys/${key.json.id}`);
    await call(ctx, "DELETE", `/api/products/${id}/logs/keys/${logKey.json.id}`);
    expect((await registry(id)).map((row) => row.revoked)).toEqual([1, 1]);
    // The reader user exists as soon as the project does.
    const users = await admin.query("SELECT name FROM system.users WHERE name = {u:String}", {
      params: { u: readerUser(id) },
    });
    expect(users.rows).toBe(1);
  });

  test("retention_changes_update_expiry_without_early_deletes", async () => {
    const { id } = await project(ctx, "Retention", 60);
    await call(ctx, "POST", `/api/products/${id}/keys`, { label: "web" });
    const day = 86_400_000;
    await seedEvents(id, [
      { event_id: "twenty", time: new Date(Date.now() - 20 * day) },
      { event_id: "forty", time: new Date(Date.now() - 40 * day) },
    ]);
    const patch = (days: number) =>
      call(ctx, "PATCH", `/api/products/${id}`, { name: "Retention", retention_days: days });
    // Shortening keeps every row still inside the new retention.
    expect((await patch(50)).status).toBe(200);
    await admin.command("OPTIMIZE TABLE piko.events FINAL");
    expect((await expiry(id)).map((row) => row.days)).toEqual([50, 50]);
    expect((await patch(90)).status).toBe(200);
    await admin.command("OPTIMIZE TABLE piko.events FINAL");
    expect(await expiry(id)).toEqual([
      { event_id: "forty", days: 90 },
      { event_id: "twenty", days: 90 },
    ]);
    expect((await registry(id))[0]?.retention_days).toBe(90);
    // Only rows past the retention go.
    expect((await patch(30)).status).toBe(200);
    await admin.command("OPTIMIZE TABLE piko.events FINAL");
    expect(await expiry(id)).toEqual([{ event_id: "twenty", days: 30 }]);
    expect((await registry(id))[0]?.retention_days).toBe(30);
  });

  test("provisioning_after_an_outage_is_repaired_by_reconcile", async () => {
    const working = ctx.admin;
    ctx.admin = new ClickHouse({ url: "http://127.0.0.1:1", user: "piko_admin", password: "x" });
    let id: string;
    try {
      const created = await call(ctx, "POST", "/api/products", {
        name: "Outage",
        retention_days: 30,
      });
      expect(created.status).toBe(200);
      id = created.json.id;
      expect((await call(ctx, "POST", `/api/products/${id}/keys`, { label: "web" })).status).toBe(
        200,
      );
      const failed = await readAs(ctx, id, (reader) =>
        reader.query("SELECT count() FROM events"),
      ).then(
        () => null,
        (error) => error,
      );
      expect(failed?.status).toBe(503);
      expect(failed?.code).toBe("analytics_unavailable");
    } finally {
      ctx.admin = working;
    }
    const repaired = await reconcile(ctx);
    expect(repaired.projects).toBeGreaterThanOrEqual(1);
    const counted = await readAs(ctx, id, (reader) =>
      reader.query<{ n: number }>("SELECT count() AS n FROM all_events"),
    );
    expect(counted.data[0]?.n).toBe(0);
    expect(await registry(id)).toHaveLength(1);
  });

  test("cleanup_removes_only_expired_rows", async () => {
    const { id } = await project(ctx, "Cleanup", 30);
    await seedEvents(id, [{ event_id: "fresh" }, { event_id: "expired" }]);
    await admin.command(
      "ALTER TABLE piko.events UPDATE expires_at = now() - INTERVAL 1 DAY WHERE product_id = {p:UUID} AND event_id = 'expired' SETTINGS mutations_sync = 2",
      { params: { p: id } },
    );
    const result = await call(ctx, "POST", "/api/cleanup", {});
    expect(result.status).toBe(200);
    // A background TTL merge may delete the row before cleanup counts it.
    expect(typeof result.json.removed).toBe("number");
    expect(typeof result.json.logs_removed).toBe("number");
    expect((await expiry(id)).map((row) => row.event_id)).toEqual(["fresh"]);
  });

  test("reconcile_is_idempotent", async () => {
    const { id } = await project(ctx, "Twice", 30);
    await call(ctx, "POST", `/api/products/${id}/keys`, { label: "web" });
    const first = await reconcile(ctx);
    const rows = await registry(id);
    const second = await reconcile(ctx);
    expect(second.projects).toBe(first.projects);
    expect(second.keys).toBe(first.keys);
    expect(await registry(id)).toEqual(rows);
  });
});
