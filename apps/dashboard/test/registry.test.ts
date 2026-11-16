import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { projectDatabase, readerUser } from "../src/server/clickhouse/access";
import { ClickHouse } from "../src/server/clickhouse/client";
import { readAs } from "../src/server/queries/read";
import { reconcile } from "../src/server/registry";
import { startJobs } from "../src/server/jobs";
import {
  call,
  project,
  seedEvents,
  seedLogs,
  type TestContext,
  testAdmin,
  testContext,
} from "./helpers";

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

async function logExpiry(productId: string) {
  return (
    await admin.query<{ log_id: string; days: number }>(
      "SELECT log_id, dateDiff('day', toDateTime(timestamp), expires_at) AS days FROM piko.logs FINAL WHERE product_id = {p:UUID} ORDER BY log_id",
      { params: { p: productId } },
    )
  ).data;
}

/** Gives rows the expiry `days` after their time, as the ingest app stamps them. */
async function stampExpiry(table: "piko.events" | "piko.logs", productId: string, days: number) {
  const time = table === "piko.events" ? "event_time" : "timestamp";
  await admin.command(
    `ALTER TABLE ${table} UPDATE expires_at = toDateTime(${time}) + toIntervalDay({days:UInt16}) WHERE product_id = {p:UUID} SETTINGS mutations_sync = 2`,
    { params: { p: productId, days } },
  );
}

const unreachable = () =>
  new ClickHouse({ url: "http://127.0.0.1:1", user: "piko_admin", password: "x" });

/** Swaps ctx.admin for one that records (and may refuse) every command, until restored. */
function recordCommands(refuse?: (sql: string) => boolean) {
  const working = ctx.admin;
  const commands: string[] = [];
  ctx.admin = new Proxy(working, {
    get(target, name) {
      if (name === "command")
        return (sql: string, options?: unknown) => {
          commands.push(sql);
          if (refuse?.(sql)) return Promise.reject(new Error("refused by the test"));
          return target.command(sql, options as never);
        };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    commands,
    restore() {
      ctx.admin = working;
    },
  };
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

  test("a_new_key_is_mirrored_at_once", async () => {
    const { id } = await project(ctx, "Fresh key", 30);
    const key = await call(ctx, "POST", `/api/products/${id}/keys`, { label: "web" });
    expect(key.status).toBe(200);
    // No other change runs a mirror, so only the key's own write can have put it there.
    expect(await registry(id)).toEqual([
      { kind: "events", revoked: 0, retention_days: 30, allowed_origins: [], source_id: id },
    ]);
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
  }, 60_000);

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
  }, 60_000);

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

  test("a_retention_change_during_an_outage_is_applied_by_reconcile", async () => {
    const { id } = await project(ctx, "Outage retention", 30);
    await call(ctx, "POST", `/api/products/${id}/keys`, { label: "web" });
    await seedEvents(id, [{ event_id: "old", time: new Date(Date.now() - 25 * 86_400_000) }]);
    await stampExpiry("piko.events", id, 30);
    const working = ctx.admin;
    ctx.admin = unreachable();
    try {
      const patched = await call(ctx, "PATCH", `/api/products/${id}`, {
        name: "Outage retention",
        retention_days: 90,
      });
      expect(patched.status).toBe(200);
    } finally {
      ctx.admin = working;
    }
    // Until it is applied the row would be deleted at 30 days, though the project keeps 90.
    await reconcile(ctx);
    expect(await expiry(id)).toEqual([{ event_id: "old", days: 90 }]);
    expect((await registry(id))[0]?.retention_days).toBe(90);
  }, 60_000);

  test("a_log_retention_change_during_an_outage_is_applied_by_reconcile", async () => {
    const { id } = await project(ctx, "Outage log retention", 30);
    await seedLogs(id, [{ log_id: "old", time: new Date(Date.now() - 5 * 86_400_000) }]);
    await stampExpiry("piko.logs", id, 7);
    const working = ctx.admin;
    ctx.admin = unreachable();
    try {
      const patched = await call(ctx, "PATCH", `/api/products/${id}/logs/settings`, {
        retention_days: 30,
      });
      expect(patched.status).toBe(200);
    } finally {
      ctx.admin = working;
    }
    await reconcile(ctx);
    expect(await logExpiry(id)).toEqual([{ log_id: "old", days: 30 }]);
  }, 60_000);

  test("rows_stored_with_the_cached_retention_after_a_change_are_repaired", async () => {
    const { id } = await project(ctx, "Cached retention", 30);
    await call(ctx, "POST", `/api/products/${id}/keys`, { label: "web" });
    const patched = await call(ctx, "PATCH", `/api/products/${id}`, {
      name: "Cached retention",
      retention_days: 90,
    });
    expect(patched.status).toBe(200);
    // The ingest app caches a key with its retention for 5 s, so a row it stores just after the
    // change still expires at 30 days.
    await seedEvents(id, [{ event_id: "late" }]);
    await stampExpiry("piko.events", id, 30);
    const now = ctx.now;
    ctx.now = () => new Date(Date.now() + 10_000);
    try {
      await reconcile(ctx);
    } finally {
      ctx.now = now;
    }
    expect(await expiry(id)).toEqual([{ event_id: "late", days: 90 }]);
  }, 60_000);

  test("reconcile_recreates_only_missing_access", async () => {
    const kept = await project(ctx, "Kept access", 30);
    const broken = await project(ctx, "Broken access", 30);
    await reconcile(ctx);
    await admin.command(`DROP VIEW ${projectDatabase(broken.id)}.logs`);
    const recorded = recordCommands();
    try {
      await reconcile(ctx);
    } finally {
      recorded.restore();
    }
    expect(recorded.commands.some((sql) => sql.includes(projectDatabase(kept.id)))).toBe(false);
    expect(
      recorded.commands.some((sql) => sql.includes(`${projectDatabase(broken.id)}.logs`)),
    ).toBe(true);
    const logs = await readAs(ctx, broken.id, (reader) =>
      reader.query<{ n: number }>("SELECT count() AS n FROM all_logs"),
    );
    expect(logs.data[0]?.n).toBe(0);
  }, 60_000);

  test("one_failing_project_does_not_stop_reconcile", async () => {
    const failing = await project(ctx, "Failing access", 30);
    const later = await project(ctx, "Later access", 30);
    await admin.command(`DROP VIEW ${projectDatabase(failing.id)}.logs`);
    await admin.command(`DROP VIEW ${projectDatabase(later.id)}.logs`);
    const recorded = recordCommands((sql) => sql.includes(projectDatabase(failing.id)));
    let result: Awaited<ReturnType<typeof reconcile>>;
    try {
      result = await reconcile(ctx);
    } finally {
      recorded.restore();
    }
    expect(result.failed).toBe(1);
    const logs = await readAs(ctx, later.id, (reader) =>
      reader.query<{ n: number }>("SELECT count() AS n FROM all_logs"),
    );
    expect(logs.data[0]?.n).toBe(0);
    await reconcile(ctx);
  }, 60_000);

  test("the_first_reconcile_after_start_refreshes_every_project", async () => {
    const { id } = await project(ctx, "Refreshed at start", 30);
    await reconcile(ctx);
    const recorded = recordCommands();
    const stop = startJobs(ctx);
    try {
      const deadline = Date.now() + 30_000;
      while (!recorded.commands.some((sql) => sql.includes(`${projectDatabase(id)}.events`))) {
        if (Date.now() > deadline)
          throw new Error("the first reconcile did not refresh the project");
        await Bun.sleep(50);
      }
    } finally {
      stop();
      recorded.restore();
    }
  }, 60_000);
});
