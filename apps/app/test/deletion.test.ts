// Deleting: a project stops at once and can be restored for 7 days, then one wipe removes it
// everywhere; an organization goes only once it has no projects; a person cannot leave an
// organization without an owner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readerUser, projectDatabase } from "../src/server/clickhouse/access";
import { reconcileOnce } from "../src/server/registry";
import { type WipePayload, wipeProject, wipeRunId } from "../src/server/wipe";
import { authRequest, joinAs, signUp } from "./auth-helpers";
import { call, project, seedEvents, seedLogs, type TestContext, testContext } from "./helpers";

const DAY = 86_400_000;

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext();
}, 300_000);
afterEach(() => ctx?.cleanup());

const as = (who: Headers) => ({ cookie: who.get("cookie") as string });

/** A project with a dashboard, a view, an ingestion key and a log key. */
async function furnished(name = "Shop") {
  const p = await project(ctx, name);
  const board = {
    version: 1,
    name: "Board",
    widgets: [
      {
        id: "views",
        title: "Page views",
        view: { type: "stat" },
        queries: { views: { signal: "events", event: "page_view", measure: "count" } },
        series: [{ expr: "views" }],
      },
    ],
  };
  expect(
    (await call(ctx, "POST", `/api/products/${p.id}/dashboards`, { document: board })).status,
  ).toBe(200);
  expect((await call(ctx, "POST", `/api/products/${p.id}/keys`, { label: "Web" })).status).toBe(
    200,
  );
  expect(
    (await call(ctx, "POST", `/api/products/${p.id}/logs/keys`, { label: "API" })).status,
  ).toBe(200);
  return p;
}

async function mirrored(productId: string): Promise<number[]> {
  const result = await ctx.admin.query<{ revoked: number }>(
    "SELECT revoked FROM highkey.ingest_keys WHERE product_id = {p:UUID}",
    { params: { p: productId } },
  );
  return result.data.map((row) => Number(row.revoked));
}

async function deletedAt(productId: string): Promise<string> {
  const { rows } = await ctx.db.execute("SELECT deleted_at FROM products WHERE id = ?", [
    productId,
  ]);
  return rows[0]?.deleted_at as string;
}

async function age(productId: string, days: number): Promise<WipePayload> {
  const when = new Date(Date.now() - days * DAY).toISOString();
  await ctx.db.execute("UPDATE products SET deleted_at = ? WHERE id = ?", [when, productId]);
  return { project: productId, deletedAt: when };
}

async function count(table: string, productId: string): Promise<number> {
  const result = await ctx.admin.query<{ n: string }>(
    `SELECT count() AS n FROM ${table} WHERE product_id = {p:UUID}`,
    { params: { p: productId } },
  );
  return Number(result.data[0]?.n);
}

describe("deleting", () => {
  test("a_deleted_projects_keys_stop_at_once", async () => {
    const shop = await furnished();
    expect(await mirrored(shop.id)).toEqual([0, 0]);
    expect((await call(ctx, "DELETE", `/api/products/${shop.id}`)).status).toBe(204);
    expect(await mirrored(shop.id)).toEqual([1, 1]);
    const listed = (await call(ctx, "GET", "/api/products")).json as { id: string }[];
    expect(listed.map((p) => p.id)).not.toContain(shop.id);
    expect((await call(ctx, "GET", `/api/products/${shop.id}/keys`)).status).toBe(404);
    expect((await call(ctx, "GET", "/api/read/products/shop/dashboards")).status).toBe(404);
    // A reconcile keeps them stopped.
    await reconcileOnce(ctx, { wipe: async () => {} });
    expect(await mirrored(shop.id)).toEqual([1, 1]);
  });

  test("a_restore_within_7_days_brings_it_back_whole", async () => {
    const shop = await furnished();
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    const trash = await call(ctx, "GET", "/api/deleted-products");
    expect(trash.json).toMatchObject([{ id: shop.id, name: "Shop" }]);
    await age(shop.id, 6);
    const restored = await call(ctx, "POST", `/api/deleted-products/${shop.id}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.json).toMatchObject({
      id: shop.id,
      slug: "shop",
      dashboards: [{ name: "Board" }],
    });
    expect(await mirrored(shop.id)).toEqual([0, 0]);
    expect((await call(ctx, "GET", `/api/products/${shop.id}/keys`)).json).toHaveLength(1);
    expect((await call(ctx, "GET", "/api/deleted-products")).json).toEqual([]);
    // Past the grace it cannot come back.
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    await age(shop.id, 8);
    expect((await call(ctx, "POST", `/api/deleted-products/${shop.id}/restore`, {})).status).toBe(
      404,
    );
  });

  test("after_7_days_one_wipe_is_enqueued_and_a_second_is_a_no_op", async () => {
    const old = await furnished("Old");
    const recent = await furnished("Recent");
    await call(ctx, "DELETE", `/api/products/${old.id}`);
    await call(ctx, "DELETE", `/api/products/${recent.id}`);
    const due = await age(old.id, 8);
    await age(recent.id, 1);
    // Like Tako: an enqueue with an id that already exists starts nothing new.
    const runs = new Map<string, WipePayload>();
    const enqueue = async (payload: WipePayload) => {
      if (!runs.has(wipeRunId(payload))) runs.set(wipeRunId(payload), payload);
    };
    await reconcileOnce(ctx, { wipe: enqueue });
    await reconcileOnce(ctx, { wipe: enqueue });
    expect([...runs.values()]).toEqual([expect.objectContaining(due)]);
    expect([...runs.keys()][0]).toStartWith(`wipe:${old.id}:${due.deletedAt}:`);
  });

  test("a_failing_wipe_does_not_hold_up_the_others_and_is_tried_again_later", async () => {
    const first = await furnished("First");
    const second = await furnished("Second");
    await call(ctx, "DELETE", `/api/products/${first.id}`);
    await call(ctx, "DELETE", `/api/products/${second.id}`);
    await age(first.id, 9);
    await age(second.id, 8);
    // Like Tako: a run id seen before (in any state, a dead one included) starts nothing.
    const runs: string[] = [];
    const seen = new Set<string>();
    const enqueue = async (payload: WipePayload) => {
      if (!seen.has(wipeRunId(payload))) runs.push(payload.project);
      seen.add(wipeRunId(payload));
    };
    // The oldest first; while its run is under way or has failed, the next one gets its turn.
    await reconcileOnce(ctx, { wipe: enqueue });
    await reconcileOnce(ctx, { wipe: enqueue });
    await reconcileOnce(ctx, { wipe: enqueue });
    expect(runs).toEqual([first.id, second.id]);
    // An hour on, a project still not wiped is tried again, as a new run.
    await ctx.db.execute("UPDATE products SET wipe_attempted_at = ? WHERE id = ?", [
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
      first.id,
    ]);
    await reconcileOnce(ctx, { wipe: enqueue });
    expect(runs).toEqual([first.id, second.id, first.id]);
  });

  test("a_wipe_leaves_no_events_logs_reader_views_or_rows", async () => {
    const shop = await furnished();
    await seedEvents(shop.id, [
      { event_id: "e1", actor_id: "v", identity_kind: "visitor", session_id: "s" },
      { event_id: "e2" },
    ]);
    expect(await count("highkey.session_events", shop.id)).toBe(1);
    await seedLogs(shop.id, [{ log_id: "l1" }]);
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    const payload = await age(shop.id, 8);
    expect(await wipeProject(ctx, payload)).toBe("wiped");
    expect(await count("highkey.events", shop.id)).toBe(0);
    expect(await count("highkey.session_events", shop.id)).toBe(0);
    expect(await count("highkey.logs", shop.id)).toBe(0);
    expect(await count("highkey.ingest_keys", shop.id)).toBe(0);
    expect(await count("highkey.ingest_key_policies", shop.id)).toBe(0);
    const users = await ctx.admin.query<{ n: string }>(
      "SELECT count() AS n FROM system.users WHERE name = {u:String}",
      { params: { u: readerUser(shop.id) } },
    );
    expect(Number(users.data[0]?.n)).toBe(0);
    const databases = await ctx.admin.query<{ n: string }>(
      "SELECT count() AS n FROM system.databases WHERE name = {d:String}",
      { params: { d: projectDatabase(shop.id) } },
    );
    expect(Number(databases.data[0]?.n)).toBe(0);
    for (const table of [
      "products",
      "sources",
      "ingestion_keys",
      "log_keys",
      "log_settings",
      "dashboards",
      "views",
    ]) {
      const column = table === "products" ? "id" : "product_id";
      const { rows } = await ctx.db.execute(
        `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`,
        [shop.id],
      );
      expect({ table, n: Number(rows[0]?.n) }).toEqual({ table, n: 0 });
    }
  });

  test("a_wipe_runs_twice_harmlessly", async () => {
    const shop = await furnished();
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    const payload = await age(shop.id, 8);
    expect(await wipeProject(ctx, payload)).toBe("wiped");
    expect(await wipeProject(ctx, payload)).toBe("skipped");
    // Each step on its own is harmless to repeat, as a workflow retry would.
    const steps: string[] = [];
    const again = await furnished("Again");
    await call(ctx, "DELETE", `/api/products/${again.id}`);
    const second = await age(again.id, 8);
    const twice = async <T>(name: string, step: () => Promise<T>) => {
      steps.push(name);
      await step();
      return step();
    };
    expect(await wipeProject(ctx, second, twice)).toBe("wiped");
    expect(steps).toEqual([
      "check",
      "events",
      "logs",
      "profiles",
      "groups",
      "session_events",
      "session_profiles",
      "event_facets",
      "cohort_snapshots",
      "access",
      "rows",
      "keys",
      "key-policies",
      "organization",
      "exclusions",
      "visitor-policies",
    ]);
  }, 60_000);

  test("a_restored_project_is_never_wiped", async () => {
    const shop = await furnished();
    await seedEvents(shop.id, [{ event_id: "kept" }]);
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    const stale = { project: shop.id, deletedAt: await deletedAt(shop.id) };
    await call(ctx, "POST", `/api/deleted-products/${shop.id}/restore`, {});
    expect(await wipeProject(ctx, stale)).toBe("skipped");
    // Deleted again, the earlier deletion's wipe still does nothing.
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    expect(await wipeProject(ctx, stale)).toBe("skipped");
    expect(await count("highkey.events", shop.id)).toBe(1);
    expect(await deletedAt(shop.id)).not.toBe(stale.deletedAt);
  });

  test("an_organization_with_projects_cannot_be_deleted", async () => {
    const auth = await ctx.auth();
    const org = (await auth.api.getSession({ headers: ctx.session }))?.session
      .activeOrganizationId as string;
    const shop = await furnished();
    const key = (await call(ctx, "POST", "/api/keys", { name: "k", access: "read" })).json.key;
    const remove = () =>
      authRequest(auth, "/organization/delete", { organizationId: org }, ctx.session);
    const refused = await remove();
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toContain("project");
    // Deleted but not yet wiped still counts.
    await call(ctx, "DELETE", `/api/products/${shop.id}`);
    expect((await remove()).ok).toBe(false);
    await wipeProject(ctx, await age(shop.id, 8));
    expect((await remove()).status).toBe(200);
    const { rows } = await ctx.db.execute(
      "SELECT count(*) AS n FROM apikey WHERE metadata LIKE ?",
      [`%${org}%`],
    );
    expect(Number(rows[0]?.n)).toBe(0);
    expect(key).toStartWith("hk_");
  });

  test("the_only_owner_with_other_members_cannot_be_deleted", async () => {
    const auth = await ctx.auth();
    const founder = await signUp(auth, "founder@example.com");
    const helper = await joinAs(auth, founder, "helper@example.com", "member");
    const shop = (
      await call(
        ctx,
        "POST",
        "/api/products",
        { name: "Founder shop", retention_days: 30 },
        as(founder),
      )
    ).json as { id: string };
    const users = (await call(ctx, "GET", "/api/admin/users")).json as {
      id: string;
      email: string;
    }[];
    const founderId = users.find((u) => u.email === "founder@example.com")?.id as string;
    const refused = await call(ctx, "DELETE", `/api/admin/users/${founderId}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain("owner");
    // Once the founder is the only member, the organization and its projects go with them.
    await auth.api.removeMember({
      body: { memberIdOrEmail: "helper@example.com" },
      headers: founder,
    });
    expect((await call(ctx, "DELETE", `/api/admin/users/${founderId}`)).status).toBe(204);
    expect(await auth.api.getSession({ headers: founder })).toBeNull();
    expect(await deletedAt(shop.id)).toBeTruthy();
    expect(await mirrored(shop.id)).toEqual([]);
    // The admin cannot delete their own account from here.
    const self = users.find((u) => u.email === "owner@highkey.test")?.id as string;
    expect((await call(ctx, "DELETE", `/api/admin/users/${self}`)).status).toBe(400);
    expect(helper.get("cookie")).toBeTruthy();
  });

  test("a_person_deleting_their_own_account_follows_the_same_rules", async () => {
    const auth = await ctx.auth();
    const founder = await signUp(auth, "founder@example.com");
    await joinAs(auth, founder, "helper@example.com", "member");
    const leave = () =>
      authRequest(auth, "/delete-user", { password: "a password long enough" }, founder);
    const refused = await leave();
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toContain("owner");
    await auth.api.removeMember({
      body: { memberIdOrEmail: "helper@example.com" },
      headers: founder,
    });
    expect((await leave()).status).toBe(200);
    expect(await auth.api.getSession({ headers: founder })).toBeNull();
  });
});
