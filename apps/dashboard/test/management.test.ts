import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cacheFavicon } from "../src/server/db/products";
import { normalizeWebsite, publicAddress } from "../src/server/website";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await testContext();
}, 300_000);

afterAll(() => ctx?.cleanup());

async function preflight(context: TestContext, path: string, origin: string) {
  return call(context, "OPTIONS", path, undefined, {
    origin,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  });
}

describe("management API", () => {
  test("management_has_no_app_auth_but_rejects_cross_site_mutations", async () => {
    expect((await call(ctx, "GET", "/api/products")).status).toBe(200);
    const forged = await call(
      ctx,
      "POST",
      "/api/products",
      { name: "CSRF", retention_days: 30 },
      { "x-piko-admin": "" },
    );
    expect(forged.status).toBe(403);
    expect(forged.json.error).toBe("Management requests require X-Piko-Admin: 1");
    expect((await call(ctx, "GET", "/api/session")).status).toBe(404);
    const created = await project(ctx, "Public ingestion");
    expect(created.slug).toBe("public-ingestion");
    expect(created.sources[0]?.id).toBe(created.id);
    expect(ctx.signals.at(-1)).toEqual({ product: created.id, signal: "dashboards" });
  });

  test("project slugs are unique and names are validated", async () => {
    const first = await project(ctx, "Same Name");
    const second = await project(ctx, "Same Name");
    expect(first.slug).toBe("same-name");
    expect(second.slug).toBe("same-name-2");
    for (const body of [
      { name: "", retention_days: 30 },
      { name: "x", retention_days: 0 },
      { name: "x", retention_days: 3651 },
    ])
      expect((await call(ctx, "POST", "/api/products", body)).status).toBe(400);
    expect(
      (await call(ctx, "POST", "/api/products", { name: "x", retention_days: 30, kind: "web" }))
        .status,
    ).toBe(422);
  });

  test("multiple_sources_share_a_project_but_keys_and_filters_are_scoped", async () => {
    const { id } = await project(ctx, "Multi-source");
    const mobile = await call(ctx, "POST", `/api/products/${id}/sources`, { name: "iOS" });
    expect(mobile.status).toBe(200);
    expect(
      (await call(ctx, "POST", `/api/products/${id}/sources`, { name: "IOS" })).json.error,
    ).toBe("A source with that name already exists in this project");
    expect(mobile.json.icon).toBeNull();
    expect(mobile.json.kind).toBeUndefined();
    expect(mobile.json.slug).toBe("ios");
    expect(
      (await call(ctx, "POST", `/api/products/${id}/sources`, { name: "Invalid", icon: "x" }))
        .status,
    ).toBe(400);
    expect(
      (await call(ctx, "POST", `/api/products/${id}/sources`, { name: "Old", kind: "mobile" }))
        .status,
    ).toBe(422);
    const source = mobile.json.id as string;
    const key = await call(ctx, "POST", `/api/products/${id}/keys`, {
      label: "iOS production",
      source_id: source,
    });
    expect(key.status).toBe(200);
    expect(key.json.source_id).toBe(source);
    expect(key.json.key).toMatch(/^pk_[0-9a-f]{64}$/);
    const other = await project(ctx, "Other project");
    expect(
      (
        await call(ctx, "POST", `/api/products/${other.id}/keys`, {
          label: "wrong",
          source_id: source,
        })
      ).status,
    ).toBe(404);
    const renamed = await call(ctx, "PATCH", `/api/products/${id}/sources/${source}`, {
      name: "iOS app",
      icon: "android",
    });
    expect(renamed.json).toMatchObject({ id: source, icon: "android", slug: "ios" });
    const listed = await call(ctx, "GET", `/api/products/${id}/sources`);
    expect(listed.json.map((s: { slug: string }) => s.slug)).toEqual(["events", "ios"]);
    expect((await call(ctx, "DELETE", `/api/products/${id}/keys/${key.json.id}`)).status).toBe(204);
  });

  test("invalid_batch_is_atomic_and_keys_are_revocable", async () => {
    const { id } = await project(ctx, "Validation");
    await call(ctx, "POST", `/api/products/${id}/keys`, { label: "test" });
    const keys = await call(ctx, "GET", `/api/products/${id}/keys`);
    const kid = keys.json[0].id as string;
    expect(keys.json[0].hash).toBeUndefined();
    expect(keys.json[0].key).toBeUndefined();
    expect(keys.json[0].prefix).toMatch(/^pk_[0-9a-f]{8}$/);
    expect(keys.json[0].revoked).toBe(false);
    const other = await project(ctx, "Other");
    expect((await call(ctx, "DELETE", `/api/products/${other.id}/keys/${kid}`)).status).toBe(404);
    expect((await call(ctx, "DELETE", `/api/products/${id}/keys/${kid}`)).status).toBe(204);
    expect((await call(ctx, "GET", `/api/products/${id}/keys`)).json[0].revoked).toBe(true);
    expect((await call(ctx, "POST", `/api/products/${id}/keys`, { label: "" })).json.error).toBe(
      "Key label must be 1–80 bytes",
    );
  });

  test("origin_restrictions_are_enforced_before_writing_and_persist", async () => {
    const { id } = await project(ctx, "Restricted site");
    const other = await project(ctx, "Other project");
    const path = `/api/products/${id}/keys`;
    const created = await call(ctx, "POST", path, {
      label: "Browser",
      allowed_origins: ["https://EXAMPLE.com:443/", "https://*.example.com"],
    });
    expect(created.status).toBe(200);
    expect(created.json.allowed_origins).toEqual(["https://example.com", "https://*.example.com"]);
    expect(
      (
        await call(ctx, "PATCH", `/api/products/${other.id}/keys/${created.json.id}`, {
          allowed_origins: [],
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(ctx, "POST", path, { label: "bad", allowed_origins: ["*"] })).json.error,
    ).toBeString();
    const many = Array.from({ length: 17 }, (_, i) => `https://site${i}.example`);
    expect(
      (await call(ctx, "POST", path, { label: "many", allowed_origins: many })).json.error,
    ).toBe("Use at most 16 allowed origins");
    const listed = await call(ctx, "GET", path);
    expect(
      listed.json.find((k: { id: string }) => k.id === created.json.id).allowed_origins,
    ).toHaveLength(2);
    expect(
      (await call(ctx, "PATCH", `${path}/${created.json.id}`, { allowed_origins: [] })).status,
    ).toBe(204);
  });

  test("project_websites_and_cached_icons_persist_clear_and_stay_scoped", async () => {
    const { id } = await project(ctx, "Website icon");
    const other = await project(ctx, "No website");
    const saved = await call(ctx, "PATCH", `/api/products/${id}`, {
      name: "Website icon",
      retention_days: 30,
      website_url: "http://127.0.0.1/path",
    });
    expect(saved.status).toBe(200);
    expect(saved.json.website_url).toBe("http://127.0.0.1");
    expect(saved.json.favicon_version).toBeNull();
    const bytes = new Uint8Array(
      readFileSync(new URL("../../../tests/fixtures/favicon.png", import.meta.url)),
    );
    const cached = cacheFavicon(ctx.store, id, "http://127.0.0.1", bytes);
    expect(cached.favicon_version).toBeString();
    // A late fetch from an old site cannot replace the current icon.
    const stale = cacheFavicon(ctx.store, id, "https://different.example", new Uint8Array([1]));
    expect(stale.favicon_version).toBe(cached.favicon_version);
    const icon = await call(ctx, "GET", `/api/products/${id}/favicon`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
    expect(icon.bytes).toEqual(bytes);
    expect((await call(ctx, "GET", `/api/products/${other.id}/favicon`)).status).toBe(404);
    // Changing the website clears the cached icon.
    const moved = await call(ctx, "PATCH", `/api/products/${id}`, {
      name: "Website icon",
      retention_days: 30,
      website_url: "http://127.0.0.2",
    });
    expect(moved.json.favicon_version).toBeNull();
  });

  test("website addresses never keep credentials, queries or private targets", () => {
    expect(normalizeWebsite("example.com/path")).toBe("https://example.com");
    expect(normalizeWebsite("")).toBeNull();
    for (const bad of ["ftp://example.com", "https://user@example.com", "https://x.test/?a=1"])
      expect(() => normalizeWebsite(bad)).toThrow();
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "::1", "::ffff:127.0.0.1"])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress("93.184.216.34")).toBe(true);
    expect(publicAddress("2606:4700::6810:85e5")).toBe(true);
  });

  test("log_keys_are_scoped_revocable_and_separate_from_event_keys", async () => {
    const { id } = await project(ctx, "Logs");
    const settings = `/api/products/${id}/logs/settings`;
    expect((await call(ctx, "GET", settings)).json).toEqual({ retention_days: 7 });
    expect((await call(ctx, "PATCH", settings, { retention_days: 1 })).json).toEqual({
      retention_days: 1,
    });
    expect((await call(ctx, "PATCH", settings, { retention_days: 0 })).status).toBe(400);
    const created = await call(ctx, "POST", `/api/products/${id}/logs/keys`, { label: "Test" });
    expect(created.json.key).toMatch(/^pl_[0-9a-f]{64}$/);
    expect(created.json.source_id).toBe(id);
    const listed = await call(ctx, "GET", `/api/products/${id}/logs/keys`);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].key).toBeUndefined();
    expect((await call(ctx, "GET", `/api/products/${id}/keys`)).json).toEqual([]);
    expect(
      (await call(ctx, "DELETE", `/api/products/${id}/logs/keys/${created.json.id}`)).status,
    ).toBe(204);
    expect((await call(ctx, "GET", `/api/products/${id}/logs/keys`)).json[0].revoked).toBe(true);
  });
});

describe("read CORS", () => {
  test("read_cors_allows_loopback_and_configured_origins_only", async () => {
    const path = "/api/read/products/anything/widgets/run";
    for (const origin of [
      "http://localhost:5173",
      "https://localhost",
      "http://127.0.0.1:3000",
      "http://[::1]:8080",
      "http://[::1]",
    ]) {
      const { headers } = await preflight(ctx, path, origin);
      expect(headers.get("access-control-allow-origin")).toBe(origin);
      expect(headers.get("access-control-allow-credentials")).toBeNull();
      const methods = headers.get("access-control-allow-methods") ?? "";
      expect(methods).toContain("GET");
      expect(methods).toContain("POST");
      expect(headers.get("access-control-allow-headers")).toContain("cf-access-client-secret");
    }
    for (const origin of [
      "https://evil.example",
      "null",
      "HTTP://LOCALHOST:5173",
      "http://Localhost:5173",
      "http://localhost.evil.com",
      "http://127.0.0.1.nip.io",
      "http://evil.com:5173",
      "ftp://localhost",
      "http://localhost:abc",
      "http://localhost/path",
      "http://user@localhost",
      "https://dash.example",
    ]) {
      const { headers } = await preflight(ctx, path, origin);
      expect({ origin, allowed: headers.get("access-control-allow-origin") }).toEqual({
        origin,
        allowed: null,
      });
    }
    const simple = await call(ctx, "GET", "/api/read/products", undefined, {
      origin: "http://localhost:5173",
    });
    expect(simple.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(simple.headers.get("access-control-allow-credentials")).toBeNull();
    const configured = { ...ctx, corsOrigins: ["https://dash.example"] };
    expect(
      (await preflight(configured, path, "https://dash.example")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("https://dash.example");
    expect(
      (await preflight(configured, path, "https://other.example")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
    const any = { ...ctx, corsOrigins: ["*"] };
    expect(
      (await preflight(any, path, "https://anything.example")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("https://anything.example");
    expect((await preflight(any, path, "null")).headers.get("access-control-allow-origin")).toBe(
      null,
    );
  });

  test("management_writes_never_send_cors", async () => {
    const any = { ...ctx, corsOrigins: ["*"] };
    for (const path of ["/api/products/anything/dashboards", "/api/products", "/api/x"]) {
      const { headers } = await preflight(any, path, "http://localhost:5173");
      expect({ path, allowed: headers.get("access-control-allow-origin") }).toEqual({
        path,
        allowed: null,
      });
    }
    const listed = await call(any, "GET", "/api/products", undefined, {
      origin: "http://localhost:5173",
    });
    expect(listed.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("read_prefix_has_no_mutating_route", async () => {
    const base = "/api/read/products/p";
    const paths = [
      "/api/read/products",
      `${base}/query`,
      `${base}/logs/query`,
      `${base}/widgets/run`,
      `${base}/catalog`,
      `${base}/dashboards`,
      `${base}/dashboards/validate`,
      `${base}/dashboards/d`,
      `${base}/dashboards/d/revisions`,
      `${base}/views`,
      `${base}/views/v`,
      "/api/read/schemas/dashboard.v1.json",
    ];
    const posts = ["query", "logs/query", "widgets/run", "dashboards/validate"];
    for (const path of paths) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const { status } = await call(ctx, method, path, {});
        expect({ method, path, refused: status === 405 || status === 404 }).toEqual({
          method,
          path,
          refused: true,
        });
      }
      if (!posts.some((post) => path.endsWith(post))) {
        const { status } = await call(ctx, "POST", path, {});
        expect({ path, refused: status === 405 || status === 404 }).toEqual({
          path,
          refused: true,
        });
      }
    }
  });
});
