import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WriteLimit } from "../src/server/dashboards/limit";
import type { Document } from "../src/server/dashboards/spec";
import { listRevisions, updateDashboard } from "../src/server/dashboards/storage";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await testContext();
}, 300_000);

afterEach(() => ctx?.cleanup());

function document(name: string) {
  return {
    version: 1,
    name,
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
}

const path = (id: string) => `/api/products/${id}/dashboards`;

async function create(id: string, name: string) {
  const reply = await call(ctx, "POST", path(id), { document: document(name) });
  expect(reply.status).toBe(200);
  return reply.json;
}

const put = (
  id: string,
  key: string,
  base: number,
  doc: unknown,
  headers: Record<string, string> = {},
) => call(ctx, "PUT", `${path(id)}/${key}`, { base_revision: base, document: doc }, headers);

const read = (p: string) => call(ctx, "GET", p);

describe("dashboard storage", () => {
  test("create_get_update_and_list_by_id_or_slug", async () => {
    const shop = await project(ctx, "Shop");
    const created = await create(shop.id, "Checkout Health");
    expect(created).toMatchObject({
      revision: 1,
      slug: "checkout-health",
      document: document("Checkout Health"),
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.bench.map((b: { widget: string }) => b.widget)).toEqual(["views"]);
    // The bench's run warns that no page_view events have arrived yet.
    expect(created.warnings.map((w: { path: string }) => w.path)).toEqual([
      "/widgets/0/queries/views/event",
    ]);
    const base = `/api/read/products/${shop.id}/dashboards`;
    const bySlug = await read(`${base}/checkout-health`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.json).toMatchObject({ revision: 1, document: document("Checkout Health") });
    expect((await read(`/api/read/products/shop/dashboards/${created.id}`)).json.id).toBe(
      created.id,
    );
    const updated = await put(shop.id, "checkout-health", 1, document("Checkout Health v2"));
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      revision: 2,
      slug: "checkout-health",
      document: { name: "Checkout Health v2" },
    });
    const list = (await read(base)).json;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: created.id,
      slug: "checkout-health",
      name: "Checkout Health v2",
      description: null,
      revision: 2,
      widgets: 1,
    });
    expect(typeof list[0].updated_at).toBe("string");
    const products = (await read("/api/read/products")).json;
    expect(products[0].dashboards).toEqual([
      { id: created.id, slug: "checkout-health", name: "Checkout Health v2" },
    ]);
    expect((await read(`${base}/nope`)).status).toBe(404);
    expect(ctx.signals.filter((s) => s.signal === "dashboards").length).toBeGreaterThanOrEqual(2);
  });

  test("stale_base_revision_conflicts", async () => {
    const shop = await project(ctx, "Shop");
    await create(shop.id, "Board");
    expect((await put(shop.id, "board", 1, document("Board"))).status).toBe(200);
    const stale = await put(shop.id, "board", 1, document("Other"));
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({
      error: "This dashboard changed since you loaded it",
      code: "revision_conflict",
      revision: 2,
    });
    const current = (await read("/api/read/products/shop/dashboards/board")).json;
    expect(current).toMatchObject({ revision: 2, document: { name: "Board" } });
  });

  test("concurrent_saves_with_one_base_revision_conflict", async () => {
    const shop = await project(ctx, "Shop");
    await create(shop.id, "Board");
    // Two agents save on the same base revision at once: one wins, the other is told it is stale.
    const results = await Promise.allSettled([
      updateDashboard(ctx.db, shop.id, "board", 1, document("First") as Document, "mcp"),
      updateDashboard(ctx.db, shop.id, "board", 1, document("Second") as Document, "mcp"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.body.code).toBe("revision_conflict");
    const revisions = await listRevisions(ctx.db, shop.id, "board");
    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
  });

  test("missing_projects_and_sources_are_named_on_dashboard_paths", async () => {
    const unknown = Bun.randomUUIDv7();
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    const widget = document("Board").widgets[0];
    const view = { version: 1, name: "View", query: { measure: "count" } };
    for (const [method, p, body] of [
      ["GET", "/api/read/products/nope/dashboards", undefined],
      ["GET", "/api/read/products/nope/catalog", undefined],
      ["GET", "/api/read/products/nope/views", undefined],
      ["POST", "/api/read/products/nope/query", { from, to }],
      ["POST", "/api/read/products/nope/widgets/run", { widget, from, to }],
      ["POST", `/api/products/${unknown}/dashboards`, { document: document("Board") }],
      ["POST", `/api/products/${unknown}/views`, { document: view }],
    ] as const) {
      const reply = await call(ctx, method, p, body);
      expect({
        p,
        status: reply.status,
        error: reply.json.error,
        code: reply.json.code,
        path: reply.json.errors?.[0]?.path,
      }).toEqual({
        p,
        status: 404,
        error: "Project not found",
        code: "not_found",
        path: "/project",
      });
    }
  });

  test("dashboards_and_views_sort_by_name_ignoring_case", async () => {
    const shop = await project(ctx, "Shop");
    for (const name of ["Zeta", "apple", "Mango"]) {
      await create(shop.id, name);
      const view = { version: 1, name, query: { measure: "count" } };
      expect(
        (await call(ctx, "POST", `/api/products/${shop.id}/views`, { document: view })).status,
      ).toBe(200);
    }
    const names = (list: { name: string }[]) => list.map((d) => d.name);
    expect(names((await read("/api/read/products/shop/dashboards")).json)).toEqual([
      "apple",
      "Mango",
      "Zeta",
    ]);
    expect(names((await read("/api/read/products/shop/views")).json)).toEqual([
      "apple",
      "Mango",
      "Zeta",
    ]);
    const listed = (await read("/api/products")).json[0];
    expect(names(listed.dashboards)).toEqual(["apple", "Mango", "Zeta"]);
    expect(names(listed.views)).toEqual(["apple", "Mango", "Zeta"]);
  });

  test("concurrent_saves_with_the_same_base_have_one_winner", async () => {
    const shop = await project(ctx, "Shop");
    await create(shop.id, "Board");
    const [a, b] = await Promise.all([
      put(shop.id, "board", 1, document("From A")),
      put(shop.id, "board", 1, document("From B")),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.revision).toBe(2);
    expect((await read("/api/read/products/shop/dashboards/board")).json.revision).toBe(2);
  });

  test("slugs_are_unique_stable_and_never_empty", async () => {
    const shop = await project(ctx, "Shop");
    expect((await create(shop.id, "Ünïcode ✨")).slug).toBe("n-code");
    expect((await create(shop.id, "Café sales")).slug).toBe("caf-sales");
    expect((await create(shop.id, "✨")).slug).toBe("dashboard");
    expect((await create(shop.id, "!!!")).slug).toBe("dashboard-2");
    expect((await create(shop.id, "Checkout")).slug).toBe("checkout");
    expect((await create(shop.id, "Checkout")).slug).toBe("checkout-2");
    expect((await create(shop.id, "Checkout")).slug).toBe("checkout-3");
    const renamed = await put(shop.id, "checkout-2", 1, document("Renamed"));
    expect(renamed.json.slug).toBe("checkout-2");
    const other = await project(ctx, "Other");
    expect((await create(other.id, "Checkout")).slug).toBe("checkout");
  });

  test("pruning_keeps_fifty_plus_each_origins_newest", async () => {
    const shop = await project(ctx, "Shop");
    await create(shop.id, "Board");
    expect(
      (await put(shop.id, "board", 1, document("By hand"), { "x-highkey-origin": "dashboard" }))
        .status,
    ).toBe(200);
    for (let base = 2; base < 62; base++)
      expect((await put(shop.id, "board", base, document("By api"))).status).toBe(200);
    const revisions = (await read("/api/read/products/shop/dashboards/board/revisions")).json;
    expect(revisions).toHaveLength(51);
    expect(revisions[0]).toMatchObject({ revision: 62, origin: "api" });
    expect(typeof revisions[0].created_at).toBe("string");
    expect(revisions.at(-1)).toMatchObject({ revision: 2, origin: "dashboard" });
    expect(revisions[49].revision).toBe(13);
  }, 60_000);

  test("restore_writes_a_new_revision", async () => {
    const shop = await project(ctx, "Shop");
    await create(shop.id, "First");
    await put(shop.id, "first", 1, document("Second"));
    const restored = await call(ctx, "POST", `${path(shop.id)}/first/revisions/1/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json).toMatchObject({
      revision: 3,
      slug: "first",
      document: document("First"),
    });
    expect((await read("/api/read/products/shop/dashboards")).json[0].name).toBe("First");
    const missing = await call(ctx, "POST", `${path(shop.id)}/first/revisions/9/restore`);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("not_found");
  });

  test("cross_site_writes_are_refused_and_limits_hold", async () => {
    const shop = await project(ctx, "Shop");
    const body = { document: document("Board") };
    expect(
      (await call(ctx, "POST", path(shop.id), body, { origin: "https://attacker.example" })).status,
    ).toBe(403);
    expect((await read("/api/read/products/shop/dashboards")).json).toEqual([]);
    for (let n = 0; n < 50; n++) await create(shop.id, `Board ${n}`);
    const limited = await call(ctx, "POST", path(shop.id), body);
    expect(limited.status).toBe(400);
    expect(limited.json).toEqual({ error: "A project holds at most 50 dashboards", code: "limit" });
    const big = await project(ctx, "Big");
    const doc: Record<string, unknown> = document("Big");
    const base = new TextEncoder().encode(JSON.stringify(doc)).length;
    doc.description = "";
    const overhead = new TextEncoder().encode(JSON.stringify(doc)).length - base;
    doc.description = "x".repeat(65_536 + 1 - base - overhead);
    expect(new TextEncoder().encode(JSON.stringify(doc)).length).toBe(65_537);
    const tooBig = await call(ctx, "POST", path(big.id), { document: doc });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.code).toBe("invalid_document");
    await create(big.id, "Big");
    const update = await put(big.id, "big", 1, doc);
    expect(update.json.code).toBe("invalid_document");
  }, 60_000);

  test("delete_removes_dashboard_and_revisions", async () => {
    const shop = await project(ctx, "Shop");
    const created = await create(shop.id, "Board");
    await put(shop.id, "board", 1, document("Board"));
    const p = `${path(shop.id)}/board`;
    expect(
      (await call(ctx, "DELETE", p, undefined, { origin: "https://attacker.example" })).status,
    ).toBe(403);
    expect((await call(ctx, "DELETE", p)).status).toBe(204);
    expect((await read("/api/read/products/shop/dashboards/board")).status).toBe(404);
    expect((await call(ctx, "DELETE", p)).status).toBe(404);
    const left = await ctx.db.execute(
      "SELECT count(*) AS n FROM dashboard_revisions WHERE dashboard_id = ?",
      [created.id],
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
  });

  test("the_validate_slug_is_reserved_so_every_dashboard_is_readable_by_slug", async () => {
    const shop = await project(ctx, "Shop");
    const first = await create(shop.id, "Validate");
    expect(first.slug).toBe("validate-2");
    expect((await create(shop.id, "Validate")).slug).toBe("validate-3");
    const shown = await read("/api/read/products/shop/dashboards/validate-2");
    expect(shown.status).toBe(200);
    expect(shown.json.id).toBe(first.id);
  });

  test("the_thirty_first_write_in_a_minute_is_rate_limited", async () => {
    ctx.writeLimit = new WriteLimit(30, 60_000);
    const shop = await project(ctx, "Shop");
    const other = await project(ctx, "Other");
    for (let n = 0; n < 30; n++) await create(shop.id, `Board ${n}`);
    const limited = await call(ctx, "POST", path(shop.id), { document: document("One too many") });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("rate_limited");
    const wait = Number(limited.headers.get("retry-after"));
    expect(wait >= 1 && wait <= 60).toBe(true);
    expect(limited.json.errors[0].message).toBe("Too many dashboard writes for this project");
    expect(limited.json.errors[0].hint).toBe(`Retry after ${wait} s`);
    await create(other.id, "Fine");
  });

  test("the schema is served on the read prefix", async () => {
    const schema = await read("/api/read/schemas/dashboard.v1.json");
    expect(schema.status).toBe(200);
    expect(schema.json.$id).toBe("/api/read/schemas/dashboard.v1.json");
  });
});
