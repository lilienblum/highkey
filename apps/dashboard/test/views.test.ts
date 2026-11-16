import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WriteLimit } from "../src/server/dashboards/limit";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await testContext();
}, 300_000);

afterEach(() => ctx?.cleanup());

// biome-ignore lint/suspicious/noExplicitAny: view documents in tests are free-form JSON.
type Json = any;

function eventView(name: string): Json {
  return {
    version: 1,
    name,
    description: "Signups on the pro plan",
    query: {
      event: "signup",
      measure: "count",
      filters: [{ property: "plan", op: "eq", value: "pro" }],
      group_by: "property:plan",
    },
  };
}

function logView(name: string): Json {
  return {
    version: 1,
    kind: "logs",
    name,
    query: { min_level: "error", service: "checkout", search: "timeout" },
    window: "1h",
  };
}

const viewsPath = (p: { id: string }) => `/api/read/products/${p.id}/views`;
const writePath = (p: { id: string }) => `/api/products/${p.id}/views`;
const read = (path: string) => call(ctx, "GET", path, undefined, { "x-piko-admin": "" });
const save = (p: { id: string }, document: Json) => call(ctx, "POST", writePath(p), { document });

describe("saved views", () => {
  test("event_views_are_created_read_replaced_and_deleted_by_id_and_slug", async () => {
    const shop = await project(ctx, "Shop");
    const created = await save(shop, eventView("Pro plan signups"));
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      slug: "pro-plan-signups",
      kind: "events",
      document: { kind: "events", query: { event: "signup" } },
    });
    const viewId = created.json.id as string;
    const list = await read(viewsPath(shop));
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({
      slug: "pro-plan-signups",
      name: "Pro plan signups",
      kind: "events",
      description: "Signups on the pro plan",
    });
    for (const key of [viewId, "pro-plan-signups"]) {
      const got = await read(`${viewsPath(shop)}/${key}`);
      expect(got.status).toBe(200);
      expect(got.json.id).toBe(viewId);
      expect(got.json.document.name).toBe("Pro plan signups");
    }
    // The project may be named by slug on reads.
    expect((await read("/api/read/products/shop/views/pro-plan-signups")).status).toBe(200);
    const replacement = eventView("Pro signups, renamed");
    replacement.query = { event: "checkout", measure: "actors" };
    const replaced = await call(ctx, "PUT", `${writePath(shop)}/pro-plan-signups`, {
      document: replacement,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json).toMatchObject({
      id: viewId,
      slug: "pro-plan-signups",
      document: { name: "Pro signups, renamed", query: { event: "checkout" } },
    });
    expect((await read(viewsPath(shop))).json[0].name).toBe("Pro signups, renamed");
    expect((await call(ctx, "DELETE", `${writePath(shop)}/${viewId}`)).status).toBe(204);
    expect((await read(`${viewsPath(shop)}/${viewId}`)).status).toBe(404);
    expect((await read(viewsPath(shop))).json).toEqual([]);
    expect((await call(ctx, "DELETE", `${writePath(shop)}/pro-plan-signups`)).status).toBe(404);
  });

  test("invalid_view_documents_report_pointer_paths", async () => {
    const shop = await project(ctx, "Shop");
    const first = async (doc: Json) => (await save(shop, doc)).json.errors[0].path;
    let doc = eventView("Bad");
    doc.query.measure = "sum";
    const sum = await save(shop, doc);
    expect(sum.status).toBe(400);
    expect(sum.json.code).toBe("invalid_document");
    expect(sum.json.errors[0].path).toBe("/query/property");
    doc = eventView("Bad");
    doc.query.filters = [{ property: "plan", op: "like", value: "pro" }];
    expect(await first(doc)).toBe("/query/filters/0/op");
    doc = eventView("Bad");
    doc.query.colour = "red";
    const colour = await save(shop, doc);
    expect(colour.status).toBe(400);
    expect(colour.json.errors[0].path).toBe("/query/colour");
    doc = eventView("Bad");
    doc.extra = 1;
    expect(await first(doc)).toBe("/extra");
    expect(await first(eventView(""))).toBe("/name");
    expect(await first(eventView("n".repeat(81)))).toBe("/name");
    doc = eventView("Long");
    doc.description = "d".repeat(281);
    expect(await first(doc)).toBe("/description");
    doc = eventView("Version");
    doc.version = 2;
    expect(await first(doc)).toBe("/version");
    doc = eventView("Kind");
    doc.kind = "metrics";
    expect(await first(doc)).toBe("/kind");
    // Log views: only filter fields, no measure, and the window is a fixed set.
    doc = logView("Bad");
    doc.query.measure = "count";
    expect(await first(doc)).toBe("/query/measure");
    doc = logView("Bad");
    doc.query.min_level = "info";
    expect(await first(doc)).toBe("/query/min_level");
    doc = logView("Bad");
    doc.query.level = "error";
    expect(await first(doc)).toBe("/query/min_level");
    doc = logView("Bad");
    doc.window = "30d";
    expect(await first(doc)).toBe("/window");
    doc = logView("Bad");
    doc.query.filters = [{ attribute: "", value: 1 }];
    expect(await first(doc)).toBe("/query/filters/0/attribute");
    expect((await read(viewsPath(shop))).json).toEqual([]);
  });

  test("views_hold_only_what_their_page_can_run", async () => {
    const shop = await project(ctx, "Shop");
    const first = async (doc: Json) => {
      const reply = await save(shop, doc);
      expect(reply.status).toBe(400);
      return reply.json.errors[0];
    };
    let doc = eventView("Newcomers");
    doc.query.measure = "new_actors";
    expect((await first(doc)).path).toBe("/query/measure");
    doc = eventView("Plans");
    doc.query.filters = [{ property: "plan", op: "in", value: ["pro", "team"] }];
    const op = await first(doc);
    expect(op.path).toBe("/query/filters/0/op");
    expect(op.hint).toContain("eq, ne, gt, gte, lt or lte");
    doc = logView("Routes");
    doc.query.filters = [{ attribute: "route", op: "contains", value: "checkout" }];
    expect((await first(doc)).path).toBe("/query/filters/0/op");
    doc = logView("Regions");
    doc.query.filters = [{ attribute: "region", op: "eq", value: "eu" }];
    expect((await save(shop, doc)).status).toBe(200);
  });

  test("slugs_are_unique_per_kind_and_validate_is_reserved", async () => {
    const shop = await project(ctx, "Shop");
    const first = (await save(shop, eventView("Checkout"))).json;
    const second = (await save(shop, eventView("Checkout"))).json;
    expect([first.slug, second.slug]).toEqual(["checkout", "checkout-2"]);
    // A log view may share a slug with an event view.
    const logs = await save(shop, logView("Checkout"));
    expect(logs.status).toBe(200);
    expect(logs.json).toMatchObject({ slug: "checkout", kind: "logs" });
    expect((await save(shop, logView("Checkout"))).json.slug).toBe("checkout-2");
    // The same slug in two kinds is told apart by `kind`, and an id always is exact.
    const path = `${viewsPath(shop)}/checkout`;
    expect((await read(`${path}?kind=logs`)).json.id).toBe(logs.json.id);
    expect((await read(`${path}?kind=events`)).json.id).toBe(first.id);
    const ambiguous = await read(path);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.json.code).toBe("ambiguous_view");
    expect((await read(`${viewsPath(shop)}?kind=logs`)).json).toHaveLength(2);
    expect((await save(shop, eventView("Validate"))).json.slug).toBe("validate-2");
    expect((await save(shop, eventView("✨"))).json.slug).toBe("view");
    // Another project has its own slugs.
    const blog = await project(ctx, "Blog");
    expect((await save(blog, eventView("Checkout"))).json.slug).toBe("checkout");
  });

  test("log_views_are_created_read_replaced_and_deleted", async () => {
    const shop = await project(ctx, "Shop");
    const created = await save(shop, logView("Checkout errors"));
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      kind: "logs",
      slug: "checkout-errors",
      document: { window: "1h", query: { min_level: "error", service: "checkout" } },
    });
    const got = await read(`${viewsPath(shop)}/checkout-errors`);
    expect(got.json.document).toEqual(created.json.document);
    // No window is allowed and means the Logs default.
    const replacement = logView("Checkout errors");
    delete replacement.window;
    replacement.query = { level: "warn", filters: [{ attribute: "region", value: "eu" }] };
    const replaced = await call(ctx, "PUT", `${writePath(shop)}/checkout-errors`, {
      document: replacement,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json.document.window).toBeUndefined();
    expect(replaced.json.document.query.filters[0].attribute).toBe("region");
    // A view keeps its kind.
    const changed = await call(ctx, "PUT", `${writePath(shop)}/${created.json.id}`, {
      document: eventView("Now events"),
    });
    expect(changed.status).toBe(400);
    expect(changed.json.errors[0].path).toBe("/kind");
    expect((await call(ctx, "DELETE", `${writePath(shop)}/checkout-errors?kind=logs`)).status).toBe(
      204,
    );
    expect((await read(viewsPath(shop))).json).toEqual([]);
  });

  test("documents_without_a_kind_are_event_views", async () => {
    const shop = await project(ctx, "Shop");
    const created = await save(shop, eventView("Plain"));
    expect(created.status).toBe(200);
    expect(eventView("Plain").kind).toBeUndefined();
    expect(created.json.kind).toBe("events");
    expect(created.json.document.kind).toBe("events");
    // A stored document written without `kind` still loads as an event view.
    ctx.store.db
      .query("UPDATE views SET document = json_remove(document, '$.kind') WHERE product_id = ?")
      .run(shop.id);
    const got = await read(`${viewsPath(shop)}/plain`);
    expect(got.status).toBe(200);
    expect(got.json.kind).toBe("events");
    expect(got.json.document.kind).toBe("events");
  });

  test("a_project_holds_at_most_one_hundred_views_across_both_kinds", async () => {
    const shop = await project(ctx, "Shop");
    for (let i = 0; i < 60; i++)
      expect((await save(shop, eventView(`Event ${i}`))).status).toBe(200);
    for (let i = 0; i < 40; i++) expect((await save(shop, logView(`Log ${i}`))).status).toBe(200);
    for (const document of [eventView("One more"), logView("One more")]) {
      const reply = await save(shop, document);
      expect(reply.status).toBe(400);
      expect(reply.json.code).toBe("limit");
    }
    // Another project is unaffected, and deleting frees a place.
    const blog = await project(ctx, "Blog");
    expect((await save(blog, eventView("Fine"))).status).toBe(200);
    expect((await call(ctx, "DELETE", `${writePath(shop)}/event-0`)).status).toBe(204);
    expect((await save(shop, logView("One more"))).status).toBe(200);
  }, 60_000);

  test("products_list_view_links_by_name_with_their_kind", async () => {
    const shop = await project(ctx, "Shop");
    await save(shop, eventView("Zeta"));
    await save(shop, logView("Beta"));
    await save(shop, eventView("Alpha"));
    const products = await read("/api/read/products");
    expect(products.status).toBe(200);
    const views = products.json.find((p: { id: string }) => p.id === shop.id).views;
    expect(views.map((v: { name: string }) => v.name)).toEqual(["Alpha", "Beta", "Zeta"]);
    expect(views[1].kind).toBe("logs");
    expect(views[0].slug).toBe("alpha");
    expect(typeof views[0].id).toBe("string");
    expect(views[0].document).toBeUndefined();
  });

  test("view_writes_need_the_marker_and_reads_do_not", async () => {
    const shop = await project(ctx, "Shop");
    const none = { "x-piko-admin": "" };
    const path = writePath(shop);
    expect((await call(ctx, "POST", path, { document: eventView("A") }, none)).status).toBe(403);
    const created = await save(shop, eventView("A"));
    const item = `${path}/${created.json.id}`;
    expect((await call(ctx, "PUT", item, { document: eventView("B") }, none)).status).toBe(403);
    expect((await call(ctx, "DELETE", item, undefined, none)).status).toBe(403);
    expect((await read(viewsPath(shop))).status).toBe(200);
    expect((await read("/api/read/products/nope/views")).status).toBe(404);
  });

  test("view_writes_emit_the_dashboards_signal_and_share_the_write_limit", async () => {
    const shop = await project(ctx, "Shop");
    const before = ctx.signals.length;
    expect((await save(shop, eventView("Live"))).status).toBe(200);
    expect(ctx.signals.slice(before)).toContainEqual(
      expect.objectContaining({ signal: "dashboards" }),
    );
    ctx.writeLimit = new WriteLimit(1, 60_000);
    expect((await save(shop, eventView("One"))).status).toBe(200);
    const limited = await save(shop, eventView("Two"));
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("rate_limited");
  });

  test("invalid_view_documents_say_view_not_dashboard", async () => {
    const shop = await project(ctx, "Shop");
    const doc = eventView("Bad");
    doc.extra = 1;
    const bad = await save(shop, doc);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("Invalid view document");
    expect(bad.json.code).toBe("invalid_document");
    const created = await save(shop, eventView("Good"));
    const replaced = await call(ctx, "PUT", `${writePath(shop)}/${created.json.id}`, {
      document: eventView(""),
    });
    expect(replaced.status).toBe(400);
    expect(replaced.json.error).toBe("Invalid view document");
  });

  test("a_bad_kind_is_a_structured_error_that_lists_the_kinds", async () => {
    const shop = await project(ctx, "Shop");
    for (const path of [
      `${viewsPath(shop)}?kind=metrics`,
      `${viewsPath(shop)}/anything?kind=metrics`,
    ]) {
      const reply = await read(path);
      expect(reply.status).toBe(400);
      expect(reply.json.code).toBe("invalid_kind");
      expect(reply.json.errors[0].path).toBe("/kind");
      expect(reply.json.errors[0].hint).toContain("events");
      expect(reply.json.errors[0].hint).toContain("logs");
    }
    const removed = await call(ctx, "DELETE", `${writePath(shop)}/anything?kind=metrics`);
    expect(removed.status).toBe(400);
    expect(removed.json.errors[0].path).toBe("/kind");
  });

  test("replacing_a_slug_that_exists_as_the_other_kind_is_a_404_naming_it", async () => {
    const shop = await project(ctx, "Shop");
    await save(shop, logView("Errors"));
    const path = `${writePath(shop)}/errors`;
    // The document names no kind, so it is an events view.
    const unnamed = await call(ctx, "PUT", path, { document: eventView("Errors") });
    expect(unnamed.status).toBe(404);
    expect(unnamed.json.code).toBe("not_found");
    expect(unnamed.json.errors[0].hint).toContain("logs");
    // A kind that is written but wrong gets the same answer.
    const doc = eventView("Errors");
    doc.kind = "events";
    const wrong = await call(ctx, "PUT", path, { document: doc });
    expect(wrong.status).toBe(404);
    expect(wrong.json.errors[0].hint).toContain("logs");
    // The right kind replaces it.
    expect((await call(ctx, "PUT", path, { document: logView("Errors") })).status).toBe(200);
    // A GET with the wrong kind says where the view is.
    const got = await read(`${viewsPath(shop)}/errors?kind=events`);
    expect(got.status).toBe(404);
    expect(got.json.errors[0].hint).toContain("logs");
  });

  test("a_slug_shared_by_both_kinds_needs_a_kind", async () => {
    const shop = await project(ctx, "Shop");
    const events = (await save(shop, eventView("Both"))).json;
    const logs = (await save(shop, logView("Both"))).json;
    expect(events.slug).toBe(logs.slug);
    const readPath = `${viewsPath(shop)}/both`;
    const write = `${writePath(shop)}/both`;
    const ambiguous = await read(readPath);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.json.code).toBe("ambiguous_view");
    expect(ambiguous.json.errors[0].hint).toContain("?kind=events");
    expect(ambiguous.json.errors[0].hint).toContain("?kind=logs");
    // A document that names no kind cannot say which view it replaces.
    const put = await call(ctx, "PUT", write, { document: eventView("Both") });
    expect(put.status).toBe(409);
    expect(put.json.code).toBe("ambiguous_view");
    // A replace takes its kind from the document, so the hint says to write it there.
    expect(put.json.errors[0].hint).toContain('"kind"');
    expect(put.json.errors[0].hint).not.toContain("?kind=");
    const removed = await call(ctx, "DELETE", write);
    expect(removed.status).toBe(409);
    expect(removed.json.code).toBe("ambiguous_view");
    // Naming the kind settles each of them.
    const doc = eventView("Both");
    doc.kind = "events";
    const named = await call(ctx, "PUT", write, { document: doc });
    expect(named.status).toBe(200);
    expect(named.json.id).toBe(events.id);
    expect((await read(`${readPath}?kind=logs`)).status).toBe(200);
    expect((await call(ctx, "DELETE", `${write}?kind=events`)).status).toBe(204);
    // With one left, the slug is no longer ambiguous.
    const left = await read(readPath);
    expect(left.status).toBe(200);
    expect(left.json.id).toBe(logs.id);
  });

  test("an_unknown_view_suggests_the_nearest_slug", async () => {
    const shop = await project(ctx, "Shop");
    await save(shop, eventView("Checkout"));
    const reply = await read(`${viewsPath(shop)}/chekout`);
    expect(reply.status).toBe(404);
    expect(reply.json.code).toBe("not_found");
    expect(reply.json.errors[0].hint).toBe("did you mean `checkout`?");
  });
});
